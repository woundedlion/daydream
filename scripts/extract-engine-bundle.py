"""Validate every bundle path before extracting a downloaded ZIP."""
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath


def extract_bundle(archive, destination):
    root = Path(destination).resolve()
    with zipfile.ZipFile(archive) as bundle:
        names = set()
        for entry in bundle.infolist():
            name = entry.filename
            parts = PurePosixPath(name).parts
            if (entry.orig_filename != name or not parts or name.startswith("/") or "\\" in name or ":" in name
                    or ".." in parts or name in names
                    or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError(f"unsafe bundle entry: {name!r}")
            target = (root / name).resolve()
            if not target.is_relative_to(root):
                raise ValueError(f"bundle entry escapes destination: {name!r}")
            names.add(name)
        root.mkdir(parents=True, exist_ok=True)
        bundle.extractall(root)


if __name__ == "__main__":
    extract_bundle(sys.argv[1], sys.argv[2])
