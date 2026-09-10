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
    float uMode;
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

// Smooth value noise (hash-based, bilinear), used for flame edge wobble and the
// ember bed so the fire curls and simmers instead of staying static.
float vnoise(vec2 q)
{
    vec2 i = floor(q);
    vec2 f = fract(q);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// One flame tongue. `base` is the tongue's anchor on the log bed; the flame
// rises toward the top of the screen (GLSL screen y grows downward, so height
// above the base is base.y - p.y). H is the flame height, W its base half-width.
// The body tapers to a point, breathes with slow noise, and its edges curl
// inward/outward more the higher up they go, so each tongue feels alive rather
// than a static teardrop.
float fireTongue(vec2 p, vec2 base, float H, float W, float seed, float t)
{
    float qx = p.x - base.x;
    float qy = base.y - p.y;
    float h = clamp(qy / max(H, 1.0), 0.0, 1.0);
    float taper = 1.0 - h;
    float w = max(W * (0.16 + 0.84 * taper * taper), 2.0);
    float bob = vnoise(vec2(seed * 7.7, t * 1.1 + seed * 4.7));
    float h2 = clamp(h + (bob - 0.5) * 0.16, 0.0, 1.0);
    float wob = (vnoise(vec2(h2 * 2.6 + seed * 3.1, t * 2.3 + seed * 8.3)) - 0.5)
              * (1.1 + 2.2 * h2);
    float d = (abs(qx) - wob * w) / max(w, 1.0);
    float body = 1.0 - smoothstep(0.25, 1.25, d);
    body *= smoothstep(-8.0, 8.0, qy);
    body *= pow(1.0 - h, 1.5);
    return max(body, 0.0);
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

    // --------------------------------------------------------------------------
    // Fireplace mode. A hearth at the bottom center of the screen: five
    // breathing flame tongues, a log bed with glowing ember cracks, rising
    // sparks, and a warm light pool washing over the wallpaper. `uIntensity`
    // (1..3) scales the whole hearth; `uSpeed` speeds the flicker up in a fire
    // that would otherwise be a slow, cozy burn.
    // --------------------------------------------------------------------------
    if (uMode > 0.5) {
        float size = 0.85 + (uIntensity - 1.0) * 0.25;
        float u = min(uRes.x, uRes.y);
        float yb = 0.86 * uRes.y;
        vec2 center = vec2(0.5 * uRes.x, yb);
        float bedHalf = 0.34 * size * u;
        float hMax = 0.38 * size * u;

        // Three center tongues plus two shorter flanking ones.
        float lum = 0.0;
        for (int i = 0; i < 5; i++) {
            float f = float(i);
            float rx = (f - 2.0) * 0.23;
            float rh = (1.0 - 0.42 * abs(f - 2.0))
                     * (0.72 + 0.28 * hash(vec2(f * 3.7, 7.1)));
            float H = hMax * clamp(rh, 0.22, 1.0);
            float W = H * 0.20;
            vec2 base = vec2(center.x + rx * bedHalf, yb);
            lum += fireTongue(p, base, H, W, 11.0 + f * 7.3, flow);
        }
        float total = clamp(lum, 0.0, 1.2);

        // Banks-of-fire color ramp: deep red edges, orange flanks, golden core.
        vec3 ramp0 = vec3(0.33, 0.05, 0.01);
        vec3 ramp1 = vec3(0.90, 0.22, 0.02);
        vec3 ramp2 = vec3(1.00, 0.55, 0.10);
        vec3 ramp3 = vec3(1.00, 0.90, 0.55);
        vec3 fire = mix(mix(mix(ramp0, ramp1, smoothstep(0.08, 0.35, total)),
                            ramp2, smoothstep(0.30, 0.62, total)),
                        ramp3, smoothstep(0.58, 0.95, total));

        // Log bed: a dark mound below the fire line whose glowing cracks
        // between logs simmer on their own slow noise.
        float yl = p.y - yb;
        float logEdge = smoothstep(0.0, 7.0, yl);
        float logSides = smoothstep(bedHalf + 6.0, bedHalf - 8.0, abs(p.x - center.x));
        float logs = logEdge * logSides;
        float emberGlow = smoothstep(0.50, 0.95, vnoise(vec2(p.x * 1.35, 3.3)))
                        * (0.55 + 0.45 * vnoise(vec2(p.x * 0.7, flow * 0.9)));
        vec3 bedCol = mix(vec3(0.075, 0.045, 0.028), vec3(1.0, 0.42, 0.10),
                          clamp(emberGlow, 0.0, 1.0));
        float bedAlpha = logs * 0.95;

        // Rising embers: one bright point per cell lane, drifting up from the
        // bed, twinkling, and fading toward the ceiling.
        vec2 sc = p / vec2(15.0, 48.0);
        vec2 sg = floor(sc);
        vec2 sf = fract(sc);
        vec2 rs = hash2(sg * 1.73 + 9.71);
        float rise = fract(sf.y + flow * (0.7 + 1.3 * rs.x));
        float sparkA = step(0.32, rs.x)
                     * smoothstep(0.30, 0.05, abs(rise - 0.42))
                     * smoothstep(0.85, 0.30, rise)
                     * smoothstep(bedHalf * 1.25, bedHalf * 0.35, abs(p.x - center.x))
                     * (0.5 + 0.5 * vnoise(vec2(sg.x * 3.1, flow * 2.2)));

        // Warm light pool around the hearth, translucent so the wallpaper reads
        // through it.
        float dGlow = length(p - vec2(center.x, yb - 18.0));
        float glow = exp(-dGlow * dGlow / (bedHalf * bedHalf * 14.5));

        vec3 col = mix(fire, bedCol, bedAlpha * 0.85);
        col = mix(col, vec3(1.0, 0.36, 0.09), glow * 0.5);
        col += sparkA * vec3(1.0, 0.68, 0.28) * 1.4;

        float alpha = clamp(lum * (0.62 + 0.18 * uIntensity) + glow * 0.42
                            + bedAlpha * 0.9 + sparkA * 0.85, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Terrain-space slant so the rain reads as falling at an angle.
    p.x += p.y * 0.08;

    // Density (uIntensity grows 0.65 -> 1.6 across intensity 1..3) tightens
    // the column spacing so higher intensity packs in visibly more drops; the
    // alpha also climbs with it for a wetter read.
    float i = 0.65 + (uIntensity - 1.0) * 0.475;
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
    float wetness = 0.10 * total + 0.05 * (i - 1.0);
    float dim = wetness + 0.10 * flash;
    float alpha = clamp(dim + total * (0.36 + 0.10 * i), 0.0, 1.0);
    alpha += clamp(boltAlpha, 0.0, 1.0) * 0.9;
    alpha *= qt_Opacity;

    fragColor = vec4(col, alpha);
}