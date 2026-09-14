# track-overlay

Накладывает телеметрию с логгера **RaceBox** на онбордовое видео с **GoPro** и выдаёт
готовый MP4. Работает локально, без облака и без телефона.

Поддерживает несколько камер одновременно: главная плюс врезка (PiP), с возможностью
менять их местами в произвольные моменты заезда.

## Статус

В разработке. План: [`docs/plans/20260914-gopro-telemetry-overlay.md`](docs/plans/20260914-gopro-telemetry-overlay.md)

## Как это устроено

Браузер рисует и показывает, ffmpeg склеивает.

```
RaceBox CSV ──┐
              ├──→ sync ──→ session.json ──→ веб-редактор ──┐
GoPro MP4/LRV ┘                                             │
                                     layout.json + overlay.webm
                                                            │
       исходные MP4 в полном разрешении ────────────────────┴──→ ffmpeg ──→ out.mp4
```

## Требования

ffmpeg 7+, Python 3.12 (через `uv`), современный браузер с поддержкой WebCodecs.

## Команды

```bash
uv sync                                                        # установка
uv run pytest && node --test web/test/*.test.js                # тесты

uv run trackoverlay build data/*.csv data/*.vbo data/GH*.MP4 -o out/session.json
uv run trackoverlay serve out/session.json                     # редактор в браузере
```

Тесты JS запускаются глобом, а не каталогом: `node --test web/test/` node 26
пытается загрузить как модуль.
