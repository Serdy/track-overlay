"""Локальный HTTP-сервер: отдаёт редактор, сессию и видео.

Без сервера обойтись не выйдет, хотя в соседнем ``DDA_Reader`` вьюер живёт прямо на
``file://``. Причина в Range-запросах: браузер перематывает видео, запрашивая куски
файла, а на ``file://`` эта механика недоступна. Плюс кто-то должен запускать ffmpeg
по кнопке экспорта.

Видео отдаётся **только по белому списку** из самой сессии, по номеру клипа и чанка.
Произвольные пути наружу не выставляются вообще, поэтому обойти каталог нечем — не
из-за проверок, а по устройству.
"""

from __future__ import annotations

import json
import mimetypes
import re
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent.parent.parent / "web"
CHUNK = 1 << 20                       # 1 МиБ на запись в сокет
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeError(Exception):
    """Запрошенный диапазон не пересекается с файлом (HTTP 416)."""


@dataclass(frozen=True)
class Media:
    """Белый список файлов, которые разрешено отдавать."""
    full: dict[tuple[str, int], Path]
    proxy: dict[tuple[str, int], Path]

    @classmethod
    def from_session(cls, payload: dict) -> "Media":
        full, proxy = {}, {}
        for clip in payload.get("clips", []):
            for i, path in enumerate(clip.get("files") or []):
                full[(clip["id"], i)] = Path(path)
            for i, path in enumerate(clip.get("proxy") or []):
                proxy[(clip["id"], i)] = Path(path)
        return cls(full, proxy)

    def resolve(self, clip_id: str, index: int, *, prefer_proxy: bool) -> Path | None:
        key = (clip_id, index)
        if prefer_proxy and key in self.proxy:
            return self.proxy[key]
        return self.full.get(key)


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """``Range: bytes=…`` → ``(первый байт, последний байт)`` включительно.

    ``None`` означает, что заголовка нет и надо отдать файл целиком.
    """
    if not header:
        return None
    match = _RANGE.match(header.strip())
    if not match:
        return None                   # непонятный заголовок — отдаём файл целиком
    first, last = match.group(1), match.group(2)

    if not first:                     # bytes=-500: последние 500 байт
        length = int(last or 0)
        if length <= 0:
            raise RangeError("пустой суффиксный диапазон")
        return max(0, size - length), size - 1

    start = int(first)
    end = int(last) if last else size - 1
    if start >= size or start > end:
        raise RangeError(f"диапазон {start}-{end} вне файла размером {size}")
    return start, min(end, size - 1)


class Handler(BaseHTTPRequestHandler):
    server_version = "trackoverlay"
    session_path: Path
    layout_path: Path
    media: Media

    def log_message(self, fmt, *args):      # тише стандартного логгера
        pass

    # --- отправка -------------------------------------------------------------

    def _send(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._send(status, json.dumps({"error": message}, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8")

    def _send_file(self, path: Path) -> None:
        """Отдаёт файл, поддерживая частичные запросы."""
        if not path.exists():
            return self._error(HTTPStatus.NOT_FOUND, f"нет файла {path.name}")
        size = path.stat().st_size
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"

        try:
            span = parse_range(self.headers.get("Range"), size)
        except RangeError as err:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if span is None:
            start, end, status = 0, size - 1, HTTPStatus.OK
        else:
            start, end = span
            status = HTTPStatus.PARTIAL_CONTENT

        self.send_response(status)
        self.send_header("Content-Type", media_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return

        remaining = end - start + 1
        with path.open("rb") as handle:
            handle.seek(start)
            while remaining > 0:
                block = handle.read(min(CHUNK, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    # --- маршруты -------------------------------------------------------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path, _, query = self.path.partition("?")

        if path in ("/", "/index.html"):
            return self._send_file(WEB_ROOT / "index.html")
        if path == "/api/session":
            return self._send_file(self.session_path)
        if path == "/api/layout":
            if not self.layout_path.exists():
                return self._error(HTTPStatus.NOT_FOUND, "раскладка ещё не сохранена")
            return self._send_file(self.layout_path)
        if path.startswith("/media/"):
            return self._serve_media(path, query)

        # Статика редактора. Приводим путь к каноническому виду и убеждаемся, что он
        # остался внутри web/ — иначе ../ вывел бы наружу.
        target = (WEB_ROOT / path.lstrip("/")).resolve()
        if not target.is_relative_to(WEB_ROOT.resolve()) or not target.is_file():
            return self._error(HTTPStatus.NOT_FOUND, f"нет ресурса {path}")
        return self._send_file(target)

    def _serve_media(self, path: str, query: str) -> None:
        parts = path.strip("/").split("/")
        if len(parts) != 3:
            return self._error(HTTPStatus.BAD_REQUEST, "ожидается /media/<клип>/<номер>")
        _, clip_id, index = parts
        if not index.isdigit():
            return self._error(HTTPStatus.BAD_REQUEST, "номер чанка должен быть числом")
        target = self.media.resolve(clip_id, int(index), prefer_proxy="proxy=1" in query)
        if target is None:
            return self._error(HTTPStatus.NOT_FOUND, f"клип {clip_id}/{index} не в сессии")
        return self._send_file(target)

    def do_POST(self):
        if self.path != "/api/layout":
            return self._error(HTTPStatus.NOT_FOUND, f"нет маршрута {self.path}")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as err:
            return self._error(HTTPStatus.BAD_REQUEST, f"раскладка не разбирается: {err}")
        self.layout_path.parent.mkdir(parents=True, exist_ok=True)
        self.layout_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._send(HTTPStatus.OK, b'{"saved":true}', "application/json")


def make_server(session_path: Path, *, layout_path: Path | None = None,
                port: int = 8712) -> ThreadingHTTPServer:
    payload = json.loads(session_path.read_text(encoding="utf-8"))
    handler = type("BoundHandler", (Handler,), {
        "session_path": session_path,
        "layout_path": layout_path or session_path.with_name("layout.json"),
        "media": Media.from_session(payload),
    })
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def serve(session_path: Path, *, port: int = 8712, open_browser: bool = True) -> None:
    httpd = make_server(session_path, port=port)
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    print(f"редактор: {url}   (Ctrl+C чтобы остановить)")
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nостановлено")
    finally:
        httpd.server_close()
