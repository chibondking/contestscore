#!/usr/bin/env python3
"""Build the dashboard's ARRL/RAC section map (public/img/map/sections.json).

Not run at deploy time -- the output is committed. Re-run only to change
the look or a section boundary. Standard library only. Source data,
downloaded into SRC_DIR (default ./mapsrc):

  US Census cartographic boundaries (public domain)
    cb_2023_us_county_20m.{shp,dbf}
        https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_20m.zip
    cb_2023_us_state_5m.{shp,dbf}   (only for the US Virgin Islands, which
        the 20m county file leaves out)
        https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_5m.zip
  Statistics Canada 2021 cartographic boundaries (Open Government Licence -
  Canada), fetched as GeoJSON from its ArcGIS service:
    prov.geojson   .../2021/Cartographic_boundary_files/MapServer/0/query
                   ?where=1%3D1&outFields=PRUID,PRENAME&outSR=4326
                   &maxAllowableOffset=0.02&f=geojson
    oncd.geojson   .../MapServer/4/query?where=PRUID%3D%2735%27
                   &outFields=CDUID,CDNAME&outSR=4326
                   &maxAllowableOffset=0.005&f=geojson
    (base: https://geo.statcan.gc.ca/geo_wa/rest/services)
  Natural Earth ne_50m_land + ne_50m_lakes (public domain) as land.geojson
    / lakes.geojson, for the background (Mexico, Greenland, the Caribbean,
    the Great Lakes) -- github.com/nvkelso/natural-earth-vector, geojson/

Section boundaries: ARRL's https://www.arrl.org/section-boundaries for the
split US states (county lists below), RAC for Ontario (2012 four-way split,
Hamilton + Niagara moved to GH in 2020). Each split state names every
section's counties except one, which takes the rest (DEFAULT_SECTION) --
so a county missing from a list lands somewhere sensible instead of
vanishing, and the script fails loudly on a listed name the data doesn't
have.

Merging counties into one section outline needs no geometry library:
adjacent counties share their boundary vertices, traversed in opposite
directions, so every directed edge whose reverse is also present is
interior and cancels; what's left chains back into the section's outer
rings. Everything is projected to Lambert conformal conic (Alaska and
Hawaii as insets), Douglas-Peucker simplified in pixel space, and written
as SVG path strings the dashboard injects (dashboard.js's sectionMapSvg()).

  python3 scripts/build-sectionmap.py [SRC_DIR]
"""
import json
import math
import os
import struct
import sys
from collections import defaultdict

SRC = sys.argv[1] if len(sys.argv) > 1 else 'mapsrc'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'map', 'sections.json')

W = 1000          # viewBox width; height follows from the projected extent
SIMPLIFY = 0.35   # Douglas-Peucker tolerance, viewBox px
# Coarser for the big, ragged northern coastlines (the Arctic archipelago
# alone was half the file), along with a larger minimum island area.
COARSE = {'TER': (0.9, 1.5), 'NL': (0.6, 0.6), 'QC': (0.6, 0.6), 'BC': (0.6, 0.6),
          'ONN': (0.6, 0.6), 'MB': (0.6, 0.6)}

# ---------------------------------------------------------------- sections

NAMES = {
    'CT': 'Connecticut', 'EMA': 'Eastern Massachusetts', 'ME': 'Maine', 'NH': 'New Hampshire',
    'RI': 'Rhode Island', 'VT': 'Vermont', 'WMA': 'Western Massachusetts',
    'ENY': 'Eastern New York', 'NLI': 'NYC-Long Island', 'NNJ': 'Northern New Jersey',
    'NNY': 'Northern New York', 'SNJ': 'Southern New Jersey', 'WNY': 'Western New York',
    'DE': 'Delaware', 'EPA': 'Eastern Pennsylvania', 'MDC': 'Maryland-DC', 'WPA': 'Western Pennsylvania',
    'AL': 'Alabama', 'GA': 'Georgia', 'KY': 'Kentucky', 'NC': 'North Carolina', 'NFL': 'Northern Florida',
    'SC': 'South Carolina', 'SFL': 'Southern Florida', 'WCF': 'West Central Florida', 'TN': 'Tennessee',
    'VA': 'Virginia', 'PR': 'Puerto Rico', 'VI': 'US Virgin Islands',
    'AR': 'Arkansas', 'LA': 'Louisiana', 'MS': 'Mississippi', 'NM': 'New Mexico', 'NTX': 'North Texas',
    'OK': 'Oklahoma', 'STX': 'South Texas', 'WTX': 'West Texas',
    'EB': 'East Bay', 'LAX': 'Los Angeles', 'ORG': 'Orange', 'SB': 'Santa Barbara',
    'SCV': 'Santa Clara Valley', 'SDG': 'San Diego', 'SF': 'San Francisco', 'SJV': 'San Joaquin Valley',
    'SV': 'Sacramento Valley', 'PAC': 'Pacific',
    'AZ': 'Arizona', 'EWA': 'Eastern Washington', 'ID': 'Idaho', 'MT': 'Montana', 'NV': 'Nevada',
    'OR': 'Oregon', 'UT': 'Utah', 'WWA': 'Western Washington', 'WY': 'Wyoming', 'AK': 'Alaska',
    'MI': 'Michigan', 'OH': 'Ohio', 'WV': 'West Virginia',
    'IL': 'Illinois', 'IN': 'Indiana', 'WI': 'Wisconsin',
    'CO': 'Colorado', 'IA': 'Iowa', 'KS': 'Kansas', 'MN': 'Minnesota', 'MO': 'Missouri',
    'NE': 'Nebraska', 'ND': 'North Dakota', 'SD': 'South Dakota',
    'AB': 'Alberta', 'BC': 'British Columbia', 'GH': 'Golden Horseshoe', 'MB': 'Manitoba',
    'NB': 'New Brunswick', 'NL': 'Newfoundland/Labrador', 'NS': 'Nova Scotia', 'ONE': 'Ontario East',
    'ONN': 'Ontario North', 'ONS': 'Ontario South', 'PE': 'Prince Edward Island', 'QC': 'Quebec',
    'SK': 'Saskatchewan', 'TER': 'Territories (YT/NT/NU)',
}

# State -> section for states that are one section, or the "everything not
# listed" section for split ones.
DEFAULT_SECTION = {
    'CA': 'LAX', 'TX': 'STX', 'FL': 'SFL', 'NY': 'WNY', 'PA': 'EPA', 'NJ': 'NNJ',
    'MA': 'EMA', 'WA': 'WWA', 'MD': 'MDC', 'DC': 'MDC', 'HI': 'PAC',
}

COUNTIES = {
    'CA': {
        'EB': 'Alameda, Contra Costa, Napa, Solano',
        'SV': 'Alpine, Amador, Butte, Colusa, El Dorado, Glenn, Lassen, Modoc, Nevada, Placer, Plumas, '
              'Sacramento, Shasta, Sierra, Siskiyou, Sutter, Tehama, Trinity, Yolo, Yuba',
        'SF': 'Del Norte, Humboldt, Lake, Marin, Mendocino, San Francisco, Sonoma',
        'SJV': 'Calaveras, Fresno, Kern, Kings, Madera, Mariposa, Merced, Mono, San Joaquin, Stanislaus, '
               'Tulare, Tuolumne',
        'SCV': 'Monterey, San Benito, San Mateo, Santa Clara, Santa Cruz',
        'ORG': 'Inyo, Orange, Riverside, San Bernardino',
        'SDG': 'Imperial, San Diego',
        'SB': 'San Luis Obispo, Santa Barbara, Ventura',
    },
    'TX': {
        'NTX': 'Anderson, Archer, Baylor, Bell, Bosque, Bowie, Brown, Camp, Cass, Cherokee, Clay, Collin, '
               'Comanche, Cooke, Coryell, Dallas, Delta, Denton, Eastland, Ellis, Erath, Falls, Fannin, '
               'Franklin, Freestone, Grayson, Gregg, Hamilton, Harrison, Henderson, Hill, Hood, Hopkins, '
               'Hunt, Jack, Johnson, Kaufman, Lamar, Lampasas, Limestone, McLennan, Marion, Mills, Montague, '
               'Morris, Nacogdoches, Navarro, Palo Pinto, Panola, Parker, Rains, Red River, Rockwall, Rusk, '
               'Shelby, Smith, Somervell, Stephens, Tarrant, Throckmorton, Titus, Upshur, Van Zandt, Wichita, '
               'Wilbarger, Wise, Wood, Young',
        'WTX': 'Andrews, Armstrong, Bailey, Borden, Brewster, Briscoe, Callahan, Carson, Castro, Childress, '
               'Cochran, Coke, Coleman, Collingsworth, Cottle, Crane, Crockett, Crosby, Culberson, Dallam, '
               'Dawson, Deaf Smith, Dickens, Donley, Ector, El Paso, Fisher, Floyd, Foard, Gaines, Garza, '
               'Glasscock, Gray, Hale, Hall, Hansford, Hardeman, Hartley, Haskell, Hemphill, Hockley, Howard, '
               'Hudspeth, Hutchinson, Irion, Jeff Davis, Jones, Kent, King, Knox, Lamb, Lipscomb, Loving, '
               'Lubbock, Lynn, Martin, Midland, Mitchell, Moore, Motley, Nolan, Ochiltree, Oldham, Parmer, '
               'Pecos, Potter, Presidio, Randall, Reagan, Reeves, Roberts, Runnels, Schleicher, Scurry, '
               'Shackelford, Sherman, Sterling, Stonewall, Sutton, Swisher, Taylor, Terrell, Terry, '
               'Tom Green, Upton, Ward, Wheeler, Winkler, Yoakum',
    },
    'FL': {
        'NFL': 'Alachua, Baker, Bay, Bradford, Calhoun, Citrus, Clay, Columbia, Dixie, Duval, Escambia, '
               'Flagler, Franklin, Gadsden, Gilchrist, Gulf, Hamilton, Hernando, Holmes, Jackson, Jefferson, '
               'Lafayette, Lake, Leon, Levy, Liberty, Madison, Marion, Nassau, Okaloosa, Orange, Putnam, '
               'Santa Rosa, Seminole, St. Johns, Sumter, Suwannee, Taylor, Union, Volusia, Wakulla, Walton, '
               'Washington',
        'WCF': 'Charlotte, DeSoto, Hardee, Highlands, Hillsborough, Manatee, Pasco, Pinellas, Polk, Sarasota',
    },
    'NY': {
        'NNY': 'Clinton, Essex, Franklin, Fulton, Hamilton, Jefferson, Lewis, Montgomery, St. Lawrence, '
               'Schoharie',
        'ENY': 'Albany, Columbia, Dutchess, Greene, Orange, Putnam, Rensselaer, Rockland, Saratoga, '
               'Schenectady, Sullivan, Ulster, Warren, Washington, Westchester',
        'NLI': 'Bronx, Kings, Nassau, New York, Queens, Richmond, Suffolk',
    },
    'PA': {
        'WPA': 'Allegheny, Armstrong, Beaver, Bedford, Blair, Butler, Cambria, Cameron, Centre, Clarion, '
               'Clearfield, Clinton, Crawford, Elk, Erie, Fayette, Forest, Franklin, Fulton, Greene, '
               'Huntingdon, Indiana, Jefferson, Lawrence, McKean, Mercer, Mifflin, Potter, Somerset, Venango, '
               'Warren, Washington, Westmoreland',
    },
    'NJ': {'SNJ': 'Atlantic, Burlington, Camden, Cape May, Cumberland, Gloucester, Mercer, Ocean, Salem'},
    'MA': {'WMA': 'Berkshire, Franklin, Hampden, Hampshire, Worcester'},
    'WA': {
        'EWA': 'Adams, Asotin, Benton, Chelan, Columbia, Douglas, Ferry, Franklin, Garfield, Grant, '
               'Kittitas, Klickitat, Lincoln, Okanogan, Pend Oreille, Spokane, Stevens, Walla Walla, '
               'Whitman, Yakima',
    },
}

# Ontario census divisions (CDNAME). Everything else is ONS. RAC defines ONE
# as Algonquin Park, Renfrew, Hastings, Prince Edward, Haliburton,
# Peterborough, Northumberland "and the cities and counties to the east";
# Kawartha Lakes isn't named and sits between Peterborough (ONE) and Durham
# (GH) -- placed in ONE here, an assumption. Muskoka falls to ONS with its
# neighbours Parry Sound and Simcoe.
ONTARIO = {
    'ONN': 'Algoma, Cochrane, Greater Sudbury / Grand Sudbury, Kenora, Manitoulin, Nipissing, '
           'Rainy River, Sudbury, Thunder Bay, Timiskaming',
    'ONE': 'Frontenac, Haliburton, Hastings, Kawartha Lakes, Lanark, Leeds and Grenville, '
           'Lennox and Addington, Northumberland, Ottawa, Peterborough, Prescott and Russell, '
           'Prince Edward, Renfrew, Stormont, Dundas and Glengarry',
    'GH': 'Durham, Halton, Hamilton, Niagara, Peel, Toronto, York',
}
ONTARIO_SPLIT = {'Stormont, Dundas and Glengarry'}  # contains the list separator

PROVINCE = {
    '10': 'NL', '11': 'PE', '12': 'NS', '13': 'NB', '24': 'QC', '46': 'MB', '47': 'SK',
    '48': 'AB', '59': 'BC', '60': 'TER', '61': 'TER', '62': 'TER',
}

# ---------------------------------------------------------------- readers


def read_dbf(path):
    with open(path, 'rb') as f:
        data = f.read()
    n, hlen, rlen = struct.unpack('<IHH', data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b'\0')[0].decode()
        fields.append((name, data[pos + 16]))
        pos += 32
    rows = []
    for i in range(n):
        rec = data[hlen + i * rlen: hlen + (i + 1) * rlen]
        row, off = {}, 1
        for name, size in fields:
            row[name] = rec[off:off + size].decode('utf-8', 'replace').strip()
            off += size
        rows.append(row)
    return rows


def read_shp(path):
    """Polygon shapefile -> list of [ring, ...] per record, ring = [(lon, lat)]."""
    with open(path, 'rb') as f:
        data = f.read()
    out, pos = [], 100
    while pos < len(data):
        _, length = struct.unpack('>II', data[pos:pos + 8])
        rec = data[pos + 8: pos + 8 + length * 2]
        pos += 8 + length * 2
        if struct.unpack('<i', rec[:4])[0] == 0:
            out.append([])
            continue
        nparts, npts = struct.unpack('<ii', rec[36:44])
        parts = list(struct.unpack('<%di' % nparts, rec[44:44 + 4 * nparts])) + [npts]
        base = 44 + 4 * nparts
        pts = [struct.unpack('<dd', rec[base + 16 * i: base + 16 * i + 16]) for i in range(npts)]
        out.append([pts[parts[i]:parts[i + 1]] for i in range(nparts)])
    return out


def shapefile(stem):
    return list(zip(read_dbf(src(stem + '.dbf')), read_shp(src(stem + '.shp'))))


def geojson_rings(geom):
    """GeoJSON polygon(s) -> rings oriented like a shapefile (outer CW, holes CCW)."""
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
    out = []
    for poly in polys:
        for i, ring in enumerate(poly):
            ring = [tuple(p) for p in ring]
            cw = signed_area(ring) < 0
            if (i == 0) != cw:
                ring.reverse()
            out.append(ring)
    return out


def src(name):
    return os.path.join(SRC, name)


def signed_area(ring):
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2

# ---------------------------------------------------------------- projection


def lcc(lon0, lat0, lat1, lat2):
    """Spherical Lambert conformal conic; returns f(lon, lat) -> (x, y), y up."""
    r = math.radians
    p1, p2 = r(lat1), r(lat2)
    n = math.log(math.cos(p1) / math.cos(p2)) / math.log(math.tan(math.pi / 4 + p2 / 2) / math.tan(math.pi / 4 + p1 / 2))
    F = math.cos(p1) * math.tan(math.pi / 4 + p1 / 2) ** n / n
    rho0 = F / math.tan(math.pi / 4 + r(lat0) / 2) ** n

    def f(lon, lat):
        rho = F / math.tan(math.pi / 4 + r(lat) / 2) ** n
        t = n * r(lon - lon0)
        return rho * math.sin(t), rho0 - rho * math.cos(t)
    f.params = {'lon0': lon0, 'n': n, 'F': F, 'rho0': rho0}
    return f


MAIN = lcc(-96, 40, 30, 55)
ALASKA = lcc(-152, 58, 55, 65)
HAWAII = lcc(-157, 20, 19, 22)


class Frame:
    """A projection plus the affine fit into a viewBox rectangle."""

    def __init__(self, proj, west, south, east, north, box=None, points=None, margin=0, top=None):
        self.proj = proj
        if points is None:
            points = [(lon, lat) for lon in range(int(west), int(east) + 1)
                      for lat in (south, north, (south + north) / 2)]
        xs, ys = zip(*(proj(lon, lat) for lon, lat in points))
        pad = margin * (max(xs) - min(xs))
        self.x0, self.x1 = min(xs) - pad, max(xs) + pad
        self.y0, self.y1 = min(ys) - pad, max(ys) + pad
        if top is not None:   # crop the top at this (lon, lat)
            self.y1 = proj(*top)[1]
        self.fit(box)

    def fit(self, box):
        if box is None:   # main frame: W wide, height from the aspect
            self.s = W / (self.x1 - self.x0)
            self.ox, self.oy = 0, 0
            self.h = (self.y1 - self.y0) * self.s
        else:             # inset: fit inside box (x, y, w, h), centred
            bx, by, bw, bh = box
            self.s = min(bw / (self.x1 - self.x0), bh / (self.y1 - self.y0))
            self.ox = bx + (bw - (self.x1 - self.x0) * self.s) / 2
            self.oy = by + (bh - (self.y1 - self.y0) * self.s) / 2
            self.h = None

    def export(self, box=None):
        """Everything dashboard.js needs to project (and invert) like this frame."""
        e = {k: round(v, 10) for k, v in self.proj.params.items()}
        e.update(x0=round(self.x0, 10), y1=round(self.y1, 10), s=round(self.s, 6),
                 ox=round(self.ox, 3), oy=round(self.oy, 3), box=box)
        return e

    def __call__(self, lon, lat):
        x, y = self.proj(lon, lat)
        return self.ox + (x - self.x0) * self.s, self.oy + (self.y1 - y) * self.s


# Main frame: fitted to landmarks at the edges of what it must show -- the
# width from all of Canada (Ellesmere to the Yukon coast), the lower 48,
# Puerto Rico and the Virgin Islands -- then cropped at the top along the
# arc through 69.2N on the central meridian (CJ, 2026-11-08: the full
# Arctic made the card taller than wide). That keeps all of Hudson Bay and
# the mainland territories' southern half; the archipelago is cut. Alaska
# and Hawaii are insets, so they don't stretch it.
MAIN_EXTENT = [
    (-133.1, 54.0),   # Haida Gwaii
    (-141.0, 69.6),   # Yukon / Alaska line at the Beaufort Sea
    (-125.0, 72.0),   # Banks Island
    (-120.0, 77.0),   # Prince Patrick Island
    (-70.0, 83.1),    # Ellesmere Island, north tip
    (-64.6, 60.4),    # Labrador, northern tip
    (-52.6, 47.5),    # St. John's
    (-64.5, 17.6),    # US Virgin Islands
    (-61.0, 15.8),    # open sea past VI, so it isn't jammed in the corner
    (-80.2, 24.5),    # Florida Keys
    (-97.2, 25.8),    # Brownsville
    (-117.1, 32.5),   # San Diego
    (-124.4, 40.4),   # Cape Mendocino
    (-129.5, 38.0),   # open Pacific, room for the Bay Area callouts
]
main = Frame(MAIN, 0, 0, 0, 0, points=MAIN_EXTENT, margin=0.015, top=(-96, 69.2))
H = round(main.h)
INSET_BOXES = {'AK': (6, H - 196, 210, 150), 'PAC': (222, H - 96, 150, 70)}
INSETS = {
    'AK': Frame(ALASKA, -170, 51, -130, 71.5, INSET_BOXES['AK']),
    'PAC': Frame(HAWAII, -160.4, 18.8, -154.7, 22.4, INSET_BOXES['PAC']),
}

# ---------------------------------------------------------------- geometry


def outline(rings):
    """Rings of adjacent polygons -> the rings of their union (shared edges cancel)."""
    edges = defaultdict(int)
    for ring in rings:
        pts = [(round(x, 4), round(y, 4)) for x, y in ring]
        for a, b in zip(pts, pts[1:]):
            if a != b:
                edges[(a, b)] += 1
    for (a, b) in list(edges):
        if edges.get((a, b)) and edges.get((b, a)):
            k = min(edges[(a, b)], edges[(b, a)])
            edges[(a, b)] -= k
            edges[(b, a)] -= k
    nxt = defaultdict(list)
    for (a, b), c in edges.items():
        for _ in range(c):
            nxt[a].append(b)
    out = []
    while nxt:
        start = next(iter(nxt))
        ring, cur = [start], start
        while True:
            b = nxt[cur].pop()
            if not nxt[cur]:
                del nxt[cur]
            ring.append(b)
            cur = b
            if cur == start or cur not in nxt:
                break
        if len(ring) > 3:
            out.append(ring)
    return out


def dp(pts, tol):
    if len(pts) < 3:
        return pts
    (ax, ay), (bx, by) = pts[0], pts[-1]
    dx, dy = bx - ax, by - ay
    L = math.hypot(dx, dy) or 1e-12
    best, idx = -1, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * (px - ax) - dx * (py - ay)) / L if (dx or dy) else math.hypot(px - ax, py - ay)
        if d > best:
            best, idx = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return dp(pts[:idx + 1], tol)[:-1] + dp(pts[idx:], tol)


def simplify_ring(ring, tol):
    # split the closed ring at its two mutually farthest-ish points so DP has
    # distinct endpoints
    far = max(range(len(ring)), key=lambda i: (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2)
    out = dp(ring[:far + 1], tol)[:-1] + dp(ring[far:], tol)
    return out if len(out) >= 4 else None


def project_rings(rings, frame):
    out = []
    for ring in rings:
        p = simplify_ring([frame(lon, lat) for lon, lat in ring], SIMPLIFY)
        if p and abs(signed_area(p)) >= 0.15:
            out.append(p)
    return out


def path(rings):
    parts = []
    for ring in rings:
        pts = ring[:-1] if ring[0] == ring[-1] else ring
        coords = ['%.1f %.1f' % p for p in pts]
        parts.append('M' + 'L'.join(coords) + 'Z')
    return ''.join(parts)


def label_point(rings):
    """A point well inside the largest ring: the grid sample farthest from its edges."""
    ring = max(rings, key=lambda r: abs(signed_area(r)))
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    best, bp = -1, ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    steps = 24
    for i in range(1, steps):
        for j in range(1, steps):
            x = min(xs) + (max(xs) - min(xs)) * i / steps
            y = min(ys) + (max(ys) - min(ys)) * j / steps
            if not inside(x, y, ring):
                continue
            d = min(seg_dist(x, y, ring[k], ring[k + 1]) for k in range(len(ring) - 1))
            if d > best:
                best, bp = d, (x, y)
    return bp, best


def inside(x, y, ring):
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def seg_dist(px, py, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = 0 if not (dx or dy) else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

# ---------------------------------------------------------------- build


# Sections too small for a label inside get one in open water with a leader
# line. A column is a stack of labels at one longitude, ordered north to
# south by where their sections are, so no two leaders cross.
CALLOUT_COLUMNS = [
    (-65.0, ['VT', 'NH', 'WMA', 'EMA', 'RI', 'CT', 'NLI', 'NNJ', 'SNJ', 'DE', 'MDC']),
    (-127.4, ['SF', 'EB', 'SCV']),
]
CALLOUTS = {'PE': (-60.6, 48.6), 'GH': (-77.6, 43.55), 'VI': (-65.6, 22.4), 'PR': (-69.0, 22.0)}
CALLOUT_STEP = 13   # px between labels in a column


def clamp(rings, pad=12):
    """Pull far-off-screen vertices onto a padded frame: a cheap clip that
    keeps the visible shape (projected edges are short) and drops the
    Arctic coastline nobody sees."""
    out = []
    for r in rings:
        out.append([(min(max(x, -pad), W + pad), min(max(y, -pad), H + pad)) for x, y in r])
    return out


def main_build():
    groups = defaultdict(list)       # section -> raw rings (lon, lat)
    used = defaultdict(set)

    lookup = {}
    for st, secs in COUNTIES.items():
        for sec, names in secs.items():
            for name in names.split(', '):
                lookup[(st, name)] = sec

    for row, rings in shapefile('cb_2023_us_county_20m'):
        st, name = row['STUSPS'], row['NAME']
        sec = lookup.get((st, name)) or DEFAULT_SECTION.get(st, st)
        if (st, name) in lookup:
            used[st].add(name)
        groups[sec].extend(rings)
    for (st, name), sec in lookup.items():
        if name not in used[st]:
            sys.exit('county not found: %s, %s (%s)' % (name, st, sec))

    for row, rings in shapefile('cb_2023_us_state_5m'):
        if row['STUSPS'] == 'VI':
            groups['VI'].extend(rings)

    on_lookup = {}
    for sec, names in ONTARIO.items():
        for name in ONTARIO_SPLIT:
            names = names.replace(name, '\0')
        for name in names.split(', '):
            on_lookup[name if name != '\0' else next(iter(ONTARIO_SPLIT))] = sec
    seen = set()
    for feat in json.load(open(src('oncd.geojson')))['features']:
        name = feat['properties']['CDNAME']
        seen.add(name)
        groups[on_lookup.get(name, 'ONS')].extend(geojson_rings(feat['geometry']))
    missing = set(on_lookup) - seen
    if missing:
        sys.exit('Ontario census division(s) not found: %s' % ', '.join(sorted(missing)))

    for feat in json.load(open(src('prov.geojson')))['features']:
        sec = PROVINCE.get(feat['properties']['PRUID'])
        if sec:
            groups[sec].extend(geojson_rings(feat['geometry']))

    unknown = set(groups) - set(NAMES)
    if unknown:
        sys.exit('rings for unknown section(s): %s' % ', '.join(sorted(unknown)))
    absent = set(NAMES) - set(groups)
    if absent:
        sys.exit('no geometry for: %s' % ', '.join(sorted(absent)))

    sections = {}
    for sec in sorted(groups):
        frame = INSETS.get(sec, main)
        rings = outline(groups[sec])
        if frame is main:
            rings = [r for r in rings if any(-1 <= x <= W + 1 and -1 <= y <= H + 1 for x, y in (main(*p) for p in r[::7] + [r[0]]))]
        tol, min_area = COARSE.get(sec, (SIMPLIFY, 0.15))
        prj = project_rings(rings, frame) if frame is not main else \
            [q for q in (simplify_ring(r, tol) for r in clamp([[main(*p) for p in r] for r in rings]))
             if q and abs(signed_area(q)) >= min_area]
        if not prj:
            sys.exit('section %s simplified away' % sec)
        (lx, ly), room = label_point(prj)
        sections[sec] = {'name': NAMES[sec], 'd': path(prj), 'lx': round(lx, 1), 'ly': round(ly, 1),
                         'fs': max(7, min(13, round(room * 0.8)))}

    for sec, (lon, lat) in CALLOUTS.items():
        e = sections[sec]
        cx, cy = main(lon, lat)
        cx, cy = min(max(cx, 16), W - 16), min(max(cy, 10), H - 10)   # pill stays on the map
        e.update(ax=e['lx'], ay=e['ly'], lx=round(cx, 1), ly=round(cy, 1), fs=9)
    for lon, secs in CALLOUT_COLUMNS:
        mid = sum(sections[s]['ly'] for s in secs) / len(secs)
        x = round(min(max(main(lon, 40)[0], 16), W - 16), 1)   # pill stays on the map
        for i, sec in enumerate(secs):
            e = sections[sec]
            y = mid + (i - (len(secs) - 1) / 2) * CALLOUT_STEP
            e.update(ax=e['lx'], ay=e['ly'], lx=x, ly=round(y, 1), fs=9)

    def background(name, min_area):
        out = []
        for feat in json.load(open(src(name)))['features']:
            for ring in geojson_rings(feat['geometry']):
                pts = [main(lon, lat) for lon, lat in ring if -180 < lon < -20 and 0 < lat < 85]
                if any(0 <= x <= W and 0 <= y <= H for x, y in pts):
                    out.append([main(lon, lat) for lon, lat in ring])
        return [r for r in (simplify_ring(r, SIMPLIFY * 1.5) for r in clamp(out))
                if r and abs(signed_area(r)) >= min_area]

    land = background('land.geojson', 0.5)
    lakes = background('lakes.geojson', 4)

    insets = [{'x': b[0], 'y': b[1], 'w': b[2], 'h': b[3]} for b in INSET_BOXES.values()]
    # Main frame first; dashboard.js picks an inset's projection for a
    # pixel inside its box, the main one everywhere else.
    frames = [main.export()] + [INSETS[k].export(list(b)) for k, b in INSET_BOXES.items()]

    out = {
        'source': 'scripts/build-sectionmap.py -- US Census, Statistics Canada, Natural Earth',
        'width': W, 'height': H,
        'land': path(land),
        'lakes': path(lakes),
        'insets': insets,
        'frames': frames,
        'sections': sections,
    }
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print('wrote %s (%d bytes, %d sections, %dx%d)' % (OUT, os.path.getsize(OUT), len(sections), W, H))
    for sec, e in sections.items():
        print('  %-4s %6d' % (sec, len(e['d'])))


if __name__ == '__main__':
    main_build()
