# Magpie

A small, local video tool for one job: turning long screen recordings into a short film that
matches a voiceover.

You upload your audio (the narration) and your videos (the recordings), mark the moments you
want to be seen at normal speed, and Magpie speeds up everything else so the whole film lands
exactly on the length of your audio. Then you export one `.mp4`.

It was built to make the demo film for [Homestead](https://mullet.town/homestead). Named after
the bird that collects small bright things.

## What it does

1. **Upload your audio.** One or more narration files, played back to back.
2. **Upload your videos.** Screen recordings or any `.mov` / `.mp4`. Magpie makes a light
   preview copy of each so scrubbing stays fast. Your originals are never changed.
3. **Mark your moments.** Pick the stretches that should play at real speed.
4. **Magpie fits the rest.** Everything between your moments is sped up so the video runs
   exactly as long as the audio.
5. **Export.** You get one `.mp4` (H.264 + AAC), saved to your Downloads folder.

Also in the box: chapters (build a film in parts and export them as one), splitting and
trimming clips, switching a clip off without deleting it, captions from a transcript, and
autosave with named project copies.

## Run it

You need **Node.js 18+** (developed on Node 22) and **ffmpeg** (with `ffprobe`) on your `PATH`.

```bash
# macOS:  brew install node ffmpeg
git clone https://github.com/joshua-mullet-town/magpie.git
cd magpie
npm start
```

Then open **http://localhost:4021**.

There are no npm packages to install. Everything you add is stored in `media/` next to the
code; delete that folder to start fresh.

## Optional settings

| Variable | What it does |
|---|---|
| `PORT` | Port to serve on (default `4021`). |
| `HOST` | Address to listen on (default `127.0.0.1`). Use `0.0.0.0` to open it from other devices on your network. |
| `MAGPIE_WHISPER_URL` | A [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) `/inference` URL, used for captions (default `http://localhost:8178/inference`). Everything else works without it. |
| `MAGPIE_INBOX` | A folder to watch. Any finished recording saved there is added to the open chapter automatically. |
| `MAGPIE_ON_EXPORT` | A script to run after every whole-film export, given the film's path (e.g. to upload it to your site). |

## Notes

- Built and used on macOS. It should run anywhere Node and ffmpeg do, but only macOS has been
  tested.
- It's a single-user tool meant to run on your own machine. There's no login, so don't expose
  it to the open internet.
- The code comments are unusually chatty: they record why each decision was made, often in
  the words of the person it was built for.

## License

MIT. See [LICENSE](LICENSE).
