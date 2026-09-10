#version 440

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    float time;
    vec2 uRes;
    float uIntensity;
    float uSpeed;
    float uFlash;
    float uStrike;
    float uStrikeSeed;
    vec2 uStrikePos;
};

float hash(vec2 p)
{
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash2(vec2 p)
{
    return vec2(hash(p), hash(p + vec2(17.7, 3.7)));
}

// One rain layer in pixel space. Every cell of `cell` pixels carries a single
// streak `th` px wide and up to `cell.y` px long, falling at its own speed,
// bright at the head and tapering along the tail, wrapping back into the top
// of the cell when it exits the bottom.
float rainLayer(vec2 p, vec2 cell, float th, float fast, float flow, vec2 seed)
{
    vec2 c = p / cell;
    vec2 g = floor(c);
    vec2 f = fract(c);

    vec2 rs = hash2(g * 1.7 + seed);
    float speed = 0.5 + 1.6 * rs.x;
    float len = cell.y * (0.2 + 0.45 * rs.y);
    float xoff = (rs.x - 0.5) * 0.42;
    float phase = hash(g * 1.7 + seed + 2.3);

    float px = f.x - 0.5 - xoff;
    float y = fract(f.y - flow * fast * speed + phase);
    float head = pow(1.0 - clamp(y * cell.y / max(len, 1.0), 0.0, 1.0), 1.9);

    float distx = abs(px * cell.x);
    float col = smoothstep(th, 0.0, distx);
    return col * head;
}

// --------------------------------------------------------------------------
// Lightning bolt. A deterministic 8-segment jagged path seeded per strike,
// drawn as the distance to its polyline (plus one side branch), so it reads
// as an actual bolt rather than a screen flash. Positions are in pixels.
// --------------------------------------------------------------------------

float segDistSq(vec2 p, vec2 a, vec2 b)
{
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1.0), 0.0, 1.0);
    vec2 q = a + t * ab;
    return dot(p - q, p - q);
}

vec2 boltPoint(int i, vec2 start, float lenPx, float ampPx, float seed)
{
    float t = float(i) / 8.0;
    float hx = hash(vec2(seed + t * 37.0, seed * 1.31 + 5.7));
    float side = mod(float(i), 2.0) * 2.0 - 1.0;
    float taper = 1.0 - 0.25 * t;
    return vec2(start.x + side * (hx - 0.5) * ampPx * 2.0 * taper,
                start.y + t * lenPx);
}

float lightningBolt(vec2 p, vec2 start, float lenPx, float ampPx, float seed)
{
    float d = 1e12;
    for (int i = 1; i <= 8; i++) {
        d = min(d, segDistSq(p, boltPoint(i - 1, start, lenPx, ampPx, seed),
                                boltPoint(i, start, lenPx, ampPx, seed)));
    }
    // One short side branch off the third joint.
    vec2 br = boltPoint(3, start, lenPx, ampPx, seed);
    float bdx = (hash(vec2(seed + 91.0, 3.3)) - 0.5) * ampPx * 1.6;
    float bdy = lenPx * 0.16;
    d = min(d, segDistSq(p, br, br + vec2(bdx, bdy)));
    return d;
}

void main()
{
    // Continuous time, no modulo: wrapping would teleport every streak at the
    // wrap instant. Precision far exceeds realistic session lengths.
    float flow = time * uSpeed;
    vec2 p = qt_TexCoord0 * uRes;

    // Slight screen-space slant so the rain reads as falling at an angle.
    p.x += p.y * 0.08;

    // Density (uIntensity grows 0.65 -> 1.6 across intensity 1..3) tightens
    // the column spacing so higher intensity packs in visibly more drops; the
    // alpha also climbs with it for a wetter read.
    float i = uIntensity;
    float a1 = rainLayer(p, vec2(20.0 / i, 96.0), 1.5, 1.00, flow, vec2(3.1, 1.7)) * 0.34;
    float a2 = rainLayer(p, vec2(34.0 / i, 160.0), 1.2, 0.62, flow, vec2(9.4, 2.9)) * 0.19;
    float a3 = rainLayer(p, vec2(56.0 / i, 240.0), 0.9, 0.36, flow, vec2(5.2, 7.1)) * 0.13;

    float total = clamp(a1 + a2 + a3, 0.0, 1.0);

    // Pale steel-blue streaks; the wet-down look darkens and cools the
    // wallpaper as the rain builds up.
    vec3 wet = vec3(0.55, 0.65, 0.85);
    vec3 col = wet * (0.4 + 1.1 * total);

    // Lightning: a distant-strike cloud glow plus the drawn bolt.
    float flash = uFlash;
    col += vec3(0.28, 0.31, 0.38) * flash * 0.6;

    float boltAlpha = 0.0;
    if (uStrike > 0.001) {
        vec2 start = vec2(uStrikePos.x * uRes.x, 0.03 * uRes.y);
        float lenPx = uStrikePos.y * uRes.y * 0.75;
        float ampPx = 0.03 * uRes.x;
        float d = lightningBolt(p, start, lenPx, ampPx, uStrikeSeed);
        float dist = sqrt(max(d, 0.0));
        float core = smoothstep(1.4, 0.0, dist);
        float glow = exp(-dist * 0.06) * 0.5;
        boltAlpha = (core + glow) * uStrike;
        col += vec3(0.72, 0.82, 1.0) * boltAlpha;
    }

    // A wet-window dim plus the streaks' own alpha keeps drops visible on both
    // bright and dark wallpapers. Heavier rain darkens the scene more.
    float wetness = 0.10 * total + 0.05 * (uIntensity - 1.0);
    float dim = wetness + 0.10 * flash;
    float alpha = clamp(dim + total * (0.36 + 0.10 * uIntensity), 0.0, 1.0);
    alpha += clamp(boltAlpha, 0.0, 1.0) * 0.9;
    alpha *= qt_Opacity;

    fragColor = vec4(col, alpha);
}