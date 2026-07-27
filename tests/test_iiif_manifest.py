import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

from generate_iiif_manifest import build_manifest, channel_order

METADATA = {
    'tileSize': 256,
    'canvasSize': 16384,
    'maxLevel': 6,
    'imageWidth': 7597,
    'imageHeight': 9674,
    'pixelSizeMM': 0.023872,
    'heightRangeMM': 1.207934,
    'channels': ['height_hf', 'height_full', 'albedo'],
    'dataRegion': {'x': 0, 'z': 0, 'width': 0.4637, 'height': 0.5905},
    'zScale': 0.0030884,
    'defaultHeightChannel': 'height_hf',
    'heightFields': {
        'height_hf': {'heightRangeMM': 1.207934, 'zScale': 0.0030884},
        'height_full': {'heightRangeMM': 29.135071, 'zScale': 0.0744916},
    },
}

BASE = 'https://example.org/iiif/blake'


def manifest():
    return build_manifest(METADATA, BASE, 'Test plate')


def choice_items(m):
    return m['items'][0]['items'][0]['items'][0]['body']['items']


def service_of(item, service_type):
    return next(s for s in item['service'] if s.get('type') == service_type)


def test_canvas_uses_real_image_dims_not_quadtree_canvas():
    canvas = manifest()['items'][0]
    assert canvas['width'] == 7597
    assert canvas['height'] == 9674


def test_context_order_presentation_last():
    ctx = manifest()['@context']
    assert ctx[-1] == 'http://iiif.io/api/presentation/3/context.json'


def test_albedo_first_then_default_height():
    assert channel_order(METADATA) == ['albedo', 'height_hf', 'height_full']


def test_choice_has_all_channels():
    items = choice_items(manifest())
    assert len(items) == 3
    assert all(i['type'] == 'Image' for i in items)


def test_body_id_is_a_shipped_static_size_not_full_max():
    albedo = choice_items(manifest())[0]
    # ceil(7597/8)=950, ceil(9674/8)=1210, must match generate_iiif_level0.py output
    assert albedo['id'] == f'{BASE}/albedo/full/950,1210/0/default.png'


def test_albedo_item_has_level0_image_service():
    albedo = choice_items(manifest())[0]
    svc = service_of(albedo, 'ImageService3')
    assert svc['profile'] == 'level0'
    assert svc['id'] == f'{BASE}/albedo'
    lm = service_of(albedo, 'LightingMapExtension')
    assert lm['mapType'] == 'albedo'
    assert 'variant' not in lm


def test_height_items_carry_physical_props():
    hf = choice_items(manifest())[1]
    lm = service_of(hf, 'LightingMapExtension')
    assert lm['mapType'] == 'height'
    assert lm['variant'] == 'hf'
    assert lm['heightRangeMM'] == 1.207934
    assert lm['zScale'] == 0.0030884
    assert lm['heightEncoding']['format'] == 'rg16'
    assert lm['default'] is True

    full = choice_items(manifest())[2]
    lm_full = service_of(full, 'LightingMapExtension')
    assert lm_full['variant'] == 'full'
    assert lm_full['heightRangeMM'] == 29.135071
    assert 'default' not in lm_full


def test_canvas_physdim_service():
    svc = manifest()['items'][0]['service'][0]
    assert svc['physicalScale'] == 0.023872
    assert svc['physicalUnits'] == 'mm'


def test_single_channel_body_is_not_wrapped_in_choice():
    m = build_manifest(METADATA, BASE, 'Albedo only', channels=['albedo'])
    body = m['items'][0]['items'][0]['items'][0]['body']
    assert body['type'] == 'Image'
    assert body['service'][1]['mapType'] == 'albedo'


def test_single_height_dataset_without_heightfields_block():
    meta = {**METADATA,
            'channels': ['height', 'albedo'],
            'defaultHeightChannel': 'height',
            'heightFields': {'height': {'heightRangeMM': 4.2, 'zScale': 0.01}}}
    m = build_manifest(meta, BASE, 'Single height')
    items = choice_items(m)
    assert [i['label']['en'][0] for i in items][0] == 'Albedo'
    lm = service_of(items[1], 'LightingMapExtension')
    assert lm['mapType'] == 'height'
    assert lm['default'] is True
