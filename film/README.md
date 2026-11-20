# Coins with rules: film sources

The Bitcoin Cash film "Coins with rules" (BCH BLAZE 2026, Media track) is made in code: every frame is drawn by an HTML page as a pure
function of time, and the narration, music and sounds are the files in this folder.

- `film2.html`: the 63 s film (1080x1920). It exposes `window.FILM` (size, fps, duration), `window.seek(t)` (draws the frame at time t)
  and `window.SCORE(audioContext, FILM)` (lays the narration and music on the same timeline). Open it in a browser and scrub.
  `timing2.js` holds the narration lines and word times; `vo2/` the narration text and audio.
- `film-hero.html` is the same film without burned-in subtitles; `hero/compose.sh` cuts the 27 s hero version from it, adds the opening and
  end cards (`hero/cards/card.html`, captured by `hero/cards/shoot.cjs`), captions and the new narration (`hero/vo/`).
- Every on-screen claim and its mainnet transaction: `facts.md`. Credits and licences of each sound: `CREDITS.md`.

## Render it yourself (the 27 s hero cut)
Needs Node 18+, `npm i playwright && npx playwright install chromium`, and ffmpeg.
```
node render-frames.cjs film-hero.html frames                   # 1890 frames of the film without subtitles
ffmpeg -framerate 30 -i frames/f%05d.jpg -c:v libx264 -crf 16 -pix_fmt yuv420p hero/render/film.video.mp4
node hero/cards/shoot.cjs                                       # opening and end cards
bash hero/compose.sh                                            # -> hero/out/coins-with-rules-hero-1080x1920.mp4
```
`compose.sh` takes four pieces of the film (0-4.4 s, 21-28.8 s, 41-45 s, 48-53.8 s), adds the cards, the captions, the five narration
lines from `hero/vo/` (the text is in `hero/vo/lines.json`) and the music, ducked under the voice and normalised to -14 LUFS.
We re-ran the card and compose steps from a clean copy of this folder on 20 Nov 2026 (same output, byte for byte the same size) and
spot-checked captured frames against our render.

## Licences
- **The film** (the rendered videos and their frames, including the narration we produced for it): **CC BY 4.0**
  (https://creativecommons.org/licenses/by/4.0/). Share it, re-cut it, translate it; credit "Swift Bot Labs" and link this repository.
- **The code** in this folder (HTML, JS, shell): MIT, like the rest of the repository.
- **Music** "Fire Place" by HoliznaCC0 (`sound/music.flac`) and the three sound effects: CC0 (see `CREDITS.md`). **Fonts** Instrument Sans and JetBrains Mono:
  SIL Open Font License (`fonts/*-OFL.txt`).
- Narration: synthetic voices (ElevenLabs: "Bella" for the narrator, "Sarah" for the customer line in the hero cut), disclosed. The card charges and calendar in the film are labelled illustrations.
