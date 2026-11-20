# Sheet Music (PWA)

An offline sheet-music library for iPad/iPhone that installs from Safari ("Add to Home Screen").

- Import PDFs. They are stored on the device (IndexedDB) and stay there after the app is closed.
- Folders with subfolders, search across everything, sort by title, date added or recently opened.
- Auto-scroll timed to the music. The app reads the PDF to find:
  - **Tempo**: "♩ = 120", "q = 120", "120 bpm", "M.M. 120", or a tempo word such as *Allegro* (estimated).
  - **Time signature**: e.g. 3/4 (assumes 4/4 if it can't find one).
  - **Bar numbers** at the start of each system. These tell it where each bar is on the page, so the scroll stays in time line by line.
  - Scanned PDFs (pictures with no text) are read with OCR (Tesseract).
- Everything can be adjusted in **Tempo & scroll**, and the settings are saved per song.
- **Setlists**: songs in the order you play them (e.g. a concert). Add songs with a song's ⋯ button, reorder with Move up / down, and press Start to play through them with next / previous song.
- **iPad layouts** (Tempo & scroll -> Display):
  - *Pages* (automatic on iPad): upright shows one page with half-page turns; sideways shows two pages like a book, where the page you finished is replaced by the next one. While playing, a small blue marker shows where the music is.
  - *Scroll*: one continuous strip; page turns land on the start of a line with room above it.
  - *Trim page margins* enlarges the music by cutting the white borders.
  - *Stage light*: Normal, Warm, or Dark (white on black) for dark stages.
  - Sideways, the library shows a sidebar with all folders and setlists.
- **Tapping the music**: left third = previous page, right third = next page, middle = show / hide the toolbars (anywhere, if the music fits on one screen). Swipe sideways for the next / previous song.
- **Scan** printed music with the camera. Each photo is flattened and cleaned to black on white. Per page you can choose **Sharp (traced)** (default: the ink traced into vector outlines, sharp at any zoom like a publisher's PDF, with no notes re-read or changed), **Clean B&W** (the cleaned photo) or **Original colour**.

## How the scroll speed is calculated

```
seconds per bar = (beats per bar × 4 ÷ beat unit) ÷ (BPM × beat-note length in quarters) × 60
```

Example: 3/4 at ♩ = 96 gives 3 ÷ 96 × 60 = 1.875 s per bar.

Each detected bar number gives a point (time, position on the page). The scroll moves smoothly between these points, keeping the bar being played about 30% down the screen. If you drag the music while it is playing, it continues from where you let go.

## Put it on GitHub Pages

1. Create a new **public** repository on GitHub, e.g. `sheet-music`.
2. Upload **everything in this folder** (keep the folder structure: `index.html`, `sw.js`, `js/`, `vendor/`, `icons/`, ...).
   - Easiest way: on the repo page click **Add file → Upload files** and drag the folder contents in.
   - Or with git:
     ```
     git init
     git add .
     git commit -m "Sheet music PWA"
     git branch -M main
     git remote add origin https://github.com/<you>/sheet-music.git
     git push -u origin main
     ```
3. In the repo: **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
4. After a minute the app is live at `https://<you>.github.io/sheet-music/`.

## Install on the iPad

1. Open the link in **Safari** (it must be Safari).
2. Tap **Share** (□↑) → **Add to Home Screen** → **Add**.
3. Open it from the Home Screen icon. It runs full screen and works offline.

> Important: the app's data belongs to the Home Screen icon. If you **delete the icon**, iOS deletes the stored PDFs with it.
> Use **⋯ → Back up library** now and then and save the file to Files/iCloud. Restore it with **⋯ → Restore from backup**.

## Updating the app

After changing any file, open `sw.js`, change `VERSION` (e.g. `'v1'` → `'v2'`) and upload again.
The iPad picks up the new version the next time it opens the app with internet (sometimes it takes two launches).

## Notes / limits

- PDFs exported from notation software (MuseScore, Sibelius, Finale, Dorico) work best, because they contain real text.
- OCR on scans is less reliable. Small bar numbers are often missed, and the app fills the gaps between the numbers it finds. The first OCR run downloads about 17 MB; after that it works offline.
- Repeats and D.S./Coda jumps are not handled yet. The scroll runs top to bottom once.
- Turn on **Show detected bar markers** in Tempo & scroll to see which bar numbers it found.
