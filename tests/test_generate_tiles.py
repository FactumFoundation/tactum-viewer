import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from generate_tiles import load_dataset, canvas_for, build_metadata, generate


@pytest.fixture
def dataset(tmp_path):
    """Tiny synthetic dataset: 300x200 image -> canvas 512, maxLevel 1."""
    w, h = 300, 200
    height = (np.arange(h * w, dtype=np.uint32).reshape(h, w) % 65536).astype(np.uint16)
    Image.fromarray(height).save(tmp_path / 'height_hf.png')
    albedo = np.zeros((h, w, 3), dtype=np.uint8)
    albedo[..., 0] = 255
    Image.fromarray(albedo).save(tmp_path / 'albedo.png')
    (tmp_path / 'dataset.json').write_text(json.dumps({
        'name': 'synthetic',
        'pixelSizeMM': 0.1,
        'albedo': 'albedo.png',
        'heightChannels': {'height_hf': {'file': 'height_hf.png',
                                         'heightRangeMM': 2.0}},
        'defaultHeightChannel': 'height_hf',
    }))
    return tmp_path


def test_canvas_for_rounds_up_to_power_of_two():
    assert canvas_for(300, 200) == 512
    assert canvas_for(256, 256) == 256
    assert canvas_for(100, 100) == 256   # never below one tile
    assert canvas_for(16384, 9674) == 16384


def test_load_dataset(dataset):
    ds, channels = load_dataset(str(dataset))
    assert ds['defaultHeightChannel'] == 'height_hf'
    arr, kind = channels['height_hf']
    assert arr.dtype == np.uint16 and kind == 'height16'
    arr, kind = channels['albedo']
    assert arr.dtype == np.uint8 and kind == 'rgb8'
    assert arr.shape == (200, 300, 3)


def test_build_metadata(dataset):
    ds, _ = load_dataset(str(dataset))
    md = build_metadata(ds, 300, 200, 512)
    assert md['tileSize'] == 256
    assert md['canvasSize'] == 512
    assert md['maxLevel'] == 1
    assert md['channels'] == ['height_hf', 'albedo']
    assert md['dataRegion'] == {'x': 0, 'z': 0,
                                'width': 300 / 512, 'height': 200 / 512}
    # zScale = heightRangeMM / (canvas * pixelSizeMM)
    assert md['zScale'] == pytest.approx(2.0 / (512 * 0.1))
    assert md['heightFields']['height_hf']['heightRangeMM'] == 2.0


def test_generate_writes_tiles_and_metadata(dataset, tmp_path):
    ds, channels = load_dataset(str(dataset))
    md = build_metadata(ds, 300, 200, 512)
    out = tmp_path / 'out'
    count = generate(channels, md, str(out))
    # level 0: 1 tile; level 1: 2x2 grid but only cols/rows covering 300x200 -> 2x1
    assert count == 3
    assert json.loads((out / 'metadata.json').read_text())['maxLevel'] == 1
    for ch in ('height_hf', 'albedo'):
        assert (out / ch / '0' / '0' / '0.png').exists()
        assert (out / ch / '1' / '1' / '0.png').exists()
        assert not (out / ch / '1' / '0' / '1.png').exists()  # below image
    tile = np.asarray(Image.open(out / 'albedo' / '0' / '0' / '0.png'))
    assert tile.shape == (256, 256, 3)


def test_load_dataset_validates_channel_dimensions(tmp_path):
    """Test that mismatched channel dimensions are caught and raise SystemExit."""
    # Create a dataset with mismatched height channel dimensions
    height = np.zeros((100, 100), dtype=np.uint16)  # 100x100
    Image.fromarray(height).save(tmp_path / 'height_hf.png')
    albedo = np.zeros((200, 300, 3), dtype=np.uint8)  # 200x300
    Image.fromarray(albedo).save(tmp_path / 'albedo.png')
    (tmp_path / 'dataset.json').write_text(json.dumps({
        'name': 'mismatched',
        'pixelSizeMM': 0.1,
        'albedo': 'albedo.png',
        'heightChannels': {'height_hf': {'file': 'height_hf.png',
                                         'heightRangeMM': 2.0}},
        'defaultHeightChannel': 'height_hf',
    }))

    with pytest.raises(SystemExit):
        load_dataset(str(tmp_path))
