#!/usr/bin/env python3
"""Build the dashboard world map's raster layers (public/img/map/).

Not run at deploy time -- the outputs are committed. Re-run only to change
the look. Needs Pillow + numpy and the public-domain source data below,
downloaded into SRC_DIR (default ./mapsrc):

  Natural Earth (naturalearthdata.com, public domain)
    HYP_50M_SR.tif   50m cross-blended hypsometric tints + shaded relief
                     https://naciscdn.org/naturalearth/50m/raster/HYP_50M_SR.zip
    OB_50M/OB_50M.tif  50m ocean-bottom shaded relief (bathymetry)
                     https://naciscdn.org/naturalearth/50m/raster/OB_50M.zip
    land.geojson     ne_50m_land            (github.com/nvkelso/natural-earth-vector)
    borders.geojson  ne_110m_admin_0_boundary_lines_land
  NASA Earth Observatory "Black Marble" 2016, 0.1 deg grayscale (public domain)
    blackmarble.jpg  https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/BlackMarble_2016_01deg_gray.jpg

Every layer is plate carree (equirectangular) over the full globe, the same
projection as dashboard.js's projectLatLon(), so they stack in the map's
1000x500 viewBox with no reprojection. Rasters are 2000x1000 (2x the
viewBox) so they stay sharp on a high-DPI screen.

  python3 scripts/build-worldmap.py [SRC_DIR]
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else 'mapsrc'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'map')
W, H = 2000, 1000
SS = 4  # supersampling for the rasterized land mask's coastline edge

Image.MAX_IMAGE_PIXELS = None


def src(name):
    return os.path.join(SRC, name)


def xy(lon, lat, w, h):
    return ((lon + 180) / 360 * w, (90 - lat) / 180 * h)


def rings(geom):
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
    for poly in polys:
        yield poly[0], poly[1:]


def land_mask():
    """ne_50m_land rasterized to an antialiased 0-255 alpha mask."""
    w, h = W * SS, H * SS
    mask = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(mask)
    for feat in json.load(open(src('land.geojson')))['features']:
        for outer, holes in rings(feat['geometry']):
            draw.polygon([xy(lon, lat, w, h) for lon, lat in outer], fill=255)
            for hole in holes:
                draw.polygon([xy(lon, lat, w, h) for lon, lat in hole], fill=0)
    return mask.resize((W, H), Image.LANCZOS)


def ramp(lum, stops):
    """Map a 0..1 luminance array onto a list of (pos, (r,g,b)) color stops."""
    pos = np.array([p for p, _ in stops])
    out = np.zeros(lum.shape + (3,), dtype=np.float32)
    for c in range(3):
        out[..., c] = np.interp(lum, pos, [rgb[c] for _, rgb in stops])
    return out.clip(0, 255).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)

    # Land: relief colors, ocean cut away to transparent so the theme's own
    # ocean layer shows through (and so the coastline follows the vector
    # land polygons, not the raster's own blurrier water edge).
    relief = Image.open(src('HYP_50M_SR.tif')).convert('RGB').resize((W, H), Image.LANCZOS)
    land = relief.convert('RGBA')
    land.putalpha(land_mask())
    land.save(os.path.join(OUT, 'land.webp'), quality=80, method=6)

    # Oceans: the bathymetry's own shading (ridges, trenches, shelves) as a
    # luminance, recolored per theme. Dark: the requested near-black navy,
    # shelves only a little lighter so the land still carries the map.
    # Light: the lighter, Simon's-map-like blues.
    ob = Image.open(src('OB_50M/OB_50M.tif')).convert('L').resize((W, H), Image.LANCZOS)
    lum = np.asarray(ob, dtype=np.float32) / 255.0
    lo, hi = np.percentile(lum, 2), np.percentile(lum, 99.5)
    lum = ((lum - lo) / (hi - lo)).clip(0, 1)
    dark = ramp(lum, [(0.0, (3, 8, 24)), (0.55, (8, 22, 52)), (0.85, (18, 44, 88)), (1.0, (34, 72, 122))])
    light = ramp(lum, [(0.0, (46, 96, 158)), (0.55, (86, 142, 198)), (0.85, (140, 188, 226)), (1.0, (188, 222, 242))])
    Image.fromarray(dark).save(os.path.join(OUT, 'ocean-dark.webp'), quality=78, method=6)
    Image.fromarray(light).save(os.path.join(OUT, 'ocean-light.webp'), quality=78, method=6)

    # City lights: warm-colored, alpha from brightness, faint noise floor
    # cut so the night side doesn't get a speckled haze over open ocean.
    bm = Image.open(src('blackmarble.jpg')).convert('L').resize((W, H), Image.LANCZOS)
    b = np.asarray(bm, dtype=np.float32) / 255.0
    alpha = (((b - 0.10) / 0.60).clip(0, 1) ** 0.8 * 255).astype(np.uint8)
    lights = np.zeros((H, W, 4), dtype=np.uint8)
    lights[..., 0], lights[..., 1], lights[..., 2] = 255, 214, 140
    lights[..., 3] = alpha
    Image.fromarray(lights, 'RGBA').save(os.path.join(OUT, 'lights.webp'), quality=80, method=6)

    # Country borders: vector, in the 1000x500 viewBox space, one path. The
    # dashboard draws this file as an <image>, which page CSS can't reach
    # into, so the stroke is set here -- a translucent near-black that reads
    # on the relief colors in both themes.
    parts = []
    for feat in json.load(open(src('borders.geojson')))['features']:
        g = feat['geometry']
        lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        for line in lines:
            pts = [xy(lon, lat, 1000, 500) for lon, lat in line]
            parts.append('M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in pts))
    with open(os.path.join(OUT, 'borders.svg'), 'w') as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500">\n'
                '<path fill="none" stroke="#141414" stroke-opacity="0.5" stroke-width="0.6" '
                f'stroke-linejoin="round" d="{"".join(parts)}"/>\n</svg>\n')

    for name in sorted(os.listdir(OUT)):
        print(f'{name:18} {os.path.getsize(os.path.join(OUT, name)) // 1024:5d} KB')


if __name__ == '__main__':
    main()
