"""
IIIF Presentation v3 manifest generator.

Converts a Tactum metadata.json into a IIIF Presentation 3 manifest where:
  - albedo is a painting annotation with a static Image API 3.0 (level0) service
  - height channels are additional Choice items carrying a LightingMapExtension
    service (mapType "height") extended with the physical properties Tactum
    needs (variant, heightRangeMM, zScale, encoding descriptor)
  - the canvas carries a Physical Dimensions service (pixel size in mm)

The manifest declares the REAL image dimensions (imageWidth x imageHeight),
not the padded power-of-2 quadtree canvas.

Usage:
  python scripts/generate_iiif_manifest.py \
      --metadata public/moss/metadata.json \
      --base-url https://example.org/iiif/moss \
      --label "Nature-printed moss (Alois Auer, 1853)" \
      --out public/moss/iiif/manifest.json
"""

import argparse
import json
import math
import os

LIGHTINGMAP_CONTEXT = 'https://iiif.bodleian.ox.ac.uk/contexts/lightingmap/context.json'
LIGHTINGMAP_PROFILE = 'http://iiif.io/api/extension/lightingmap'
PHYSDIM_CONTEXT = 'http://iiif.io/api/annex/services/physdim/1/context.json'
PHYSDIM_PROFILE = 'http://iiif.io/api/annex/services/physdim'

HEIGHT_ENCODING = {
    'format': 'rg16',
    'description': (
        '16-bit normalised height per pixel: R holds the high byte, G the low '
        'byte. 0 maps to the lowest point, 65535 to the highest; multiply the '
        'normalised value by heightRangeMM for millimetres.'
    ),
}


def channel_label(name, height_fields):
    if name in height_fields:
        range_mm = height_fields[name].get('heightRangeMM')
        suffix = f' ({range_mm:g} mm range)' if range_mm else ''
        pretty = name.replace('height_', '').upper()
        return f'Height - {pretty}{suffix}'
    return name.capitalize()


def image_service(base_url, channel):
    return {
        'id': f'{base_url}/{channel}',
        'type': 'ImageService3',
        'profile': 'level0',
    }


def lightingmap_service(base_url, channel, metadata):
    service = {
        'id': f'{base_url}/{channel}',
        'type': 'LightingMapExtension',
        'profile': LIGHTINGMAP_PROFILE,
    }
    if channel not in metadata.get('heightFields', {}):
        service['mapType'] = channel  # albedo, normal, ...
        return service

    field = metadata['heightFields'][channel]
    service['mapType'] = 'height'
    service['variant'] = channel.replace('height_', '')
    service['heightRangeMM'] = field['heightRangeMM']
    service['zScale'] = field['zScale']
    service['heightEncoding'] = HEIGHT_ENCODING
    if channel == metadata.get('defaultHeightChannel'):
        service['default'] = True
    return service


# largest full-image size shipped by the static level-0 packager
# (see generate_iiif_level0.py THUMB_SCALE_FACTORS)
BODY_SCALE_FACTOR = 8


def body_image_url(base_url, channel, metadata):
    w = math.ceil(metadata['imageWidth'] / BODY_SCALE_FACTOR)
    h = math.ceil(metadata['imageHeight'] / BODY_SCALE_FACTOR)
    return f'{base_url}/{channel}/full/{w},{h}/0/default.png'


def choice_item(base_url, channel, metadata):
    w, h = metadata['imageWidth'], metadata['imageHeight']
    return {
        'id': body_image_url(base_url, channel, metadata),
        'type': 'Image',
        'format': 'image/png',
        'label': {'en': [channel_label(channel, metadata.get('heightFields', {}))]},
        'width': w,
        'height': h,
        'service': [
            image_service(base_url, channel),
            lightingmap_service(base_url, channel, metadata),
        ],
    }


def channel_order(metadata, channels=None):
    """albedo first (2D viewers pick it), then default height, then the rest."""
    channels = list(channels or metadata['channels'])
    default = metadata.get('defaultHeightChannel')

    def key(name):
        if name == 'albedo':
            return (0, name)
        if name == default:
            return (1, name)
        return (2, name)

    return sorted(channels, key=key)


def build_manifest(metadata, base_url, label, channels=None):
    base_url = base_url.rstrip('/')
    w, h = metadata['imageWidth'], metadata['imageHeight']
    canvas_id = f'{base_url}/canvas/1'

    items = [choice_item(base_url, ch, metadata)
             for ch in channel_order(metadata, channels)]
    # a single channel needs no Choice wrapper (and some viewers, e.g.
    # Universal Viewer, do not handle Choice bodies)
    body = items[0] if len(items) == 1 else {'type': 'Choice', 'items': items}

    return {
        '@context': [
            LIGHTINGMAP_CONTEXT,
            'http://iiif.io/api/presentation/3/context.json',
        ],
        'id': f'{base_url}/manifest.json',
        'type': 'Manifest',
        'label': {'en': [label]},
        'items': [{
            'id': canvas_id,
            'type': 'Canvas',
            'width': w,
            'height': h,
            'service': [{
                '@context': PHYSDIM_CONTEXT,
                '@id': f'{base_url}/physdim',
                '@type': 'PhysicalDimensionsService',
                'profile': PHYSDIM_PROFILE,
                'physicalScale': metadata['pixelSizeMM'],
                'physicalUnits': 'mm',
            }],
            'items': [{
                'id': f'{canvas_id}/page/1',
                'type': 'AnnotationPage',
                'items': [{
                    'id': f'{canvas_id}/page/1/anno/1',
                    'type': 'Annotation',
                    'motivation': 'painting',
                    'target': canvas_id,
                    'body': body,
                }],
            }],
        }],
    }


def main():
    parser = argparse.ArgumentParser(description='Generate a IIIF Presentation v3 manifest from metadata.json.')
    parser.add_argument('--metadata', required=True, help='path to a Tactum metadata.json')
    parser.add_argument('--base-url', required=True, help='public base URL of the dataset (no trailing slash)')
    parser.add_argument('--label', required=True, help='manifest label (English)')
    parser.add_argument('--out', help='output path (default: manifest.json next to metadata.json)')
    parser.add_argument('--channels', nargs='*',
                        help='override the channel list (e.g. "--channels albedo" for a 2D-only manifest)')
    args = parser.parse_args()

    with open(args.metadata) as f:
        metadata = json.load(f)

    manifest = build_manifest(metadata, args.base_url, args.label, channels=args.channels)

    out = args.out or os.path.join(os.path.dirname(args.metadata), 'manifest.json')
    with open(out, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'Manifest written to {out}')


if __name__ == '__main__':
    main()
