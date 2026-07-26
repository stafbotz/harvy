#!/bin/sh
#
# Menyuntikkan konteks Harvy ke awal sesi coding agent.
#
# Dipanggil oleh hook SessionStart di .claude/settings.json. Tujuannya membuat
# konteks hadir tanpa perlu diminta, karena instruksi yang hanya berharap dibaca
# akan dilewati.

root=$(git rev-parse --show-toplevel 2>/dev/null) || root=.
cd "$root" || exit 0

cat <<'KONTRAK'
=== Konteks Harvy (otomatis, dari scripts/session-context.sh) ===

Kontrak yang berlaku di repositori ini:
1. Baca konteks sebelum menjawab: docs/PROJECT.md, docs/CONSTITUTION.md,
   docs/engineering/STATUS.md, docs/LOG.md.
2. Jangan mengklaim kemampuan yang belum diperiksa di STATUS.md atau di kode.
3. Tulis entri docs/LOG.md sebelum sesi berakhir — termasuk sesi yang hanya
   berdiskusi. Commit tanpa entri LOG akan ditolak hook pre-commit.

Selengkapnya di AGENTS.md.
KONTRAK

if [ -f docs/LOG.md ]; then
  echo
  echo "--- Entri terakhir docs/LOG.md ---"
  awk '/^## /{found=1} found && /^---$/{exit} found{print}' docs/LOG.md
fi

if [ -f docs/engineering/STATUS.md ]; then
  echo "--- Cacat yang diketahui (docs/engineering/STATUS.md) ---"
  awk '/^## Cacat yang diketahui/{found=1; next} found && /^## /{exit} found{print}' \
    docs/engineering/STATUS.md
fi

echo "=== Akhir konteks otomatis ==="
