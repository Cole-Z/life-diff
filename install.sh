#!/bin/sh
# Install the lifediff binary and the Life Diff agent skill from a GitHub release.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Cole-Z/life-diff/main/install.sh | sh
# Optional: LIFEDIFF_VERSION=v0.2.0 LIFEDIFF_BIN_DIR=... LIFEDIFF_SKILL_DIR=...
set -eu

repo="${LIFEDIFF_REPO:-Cole-Z/life-diff}"
version="${LIFEDIFF_VERSION:-}"

os=$(uname -s)
case "$os" in
  Darwin) goos=darwin ;;
  Linux) goos=linux ;;
  MINGW*|MSYS*|CYGWIN*) goos=windows ;;
  *)
    echo "Unsupported operating system: $os" >&2
    exit 1
    ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) goarch=amd64 ;;
  arm64|aarch64) goarch=arm64 ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

if [ -z "$version" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' \
    | head -n 1)
  if [ -z "$tag" ]; then
    echo "No GitHub release was found for ${repo}." >&2
    echo "Push a tag such as v0.2.0, or set LIFEDIFF_VERSION." >&2
    exit 1
  fi
  version=$tag
fi

case "$version" in
  v*) ver=${version#v} ;;
  *)
    ver=$version
    version="v${version}"
    ;;
esac

ext=tar.gz
binname=lifediff
if [ "$goos" = "windows" ]; then
  ext=zip
  binname=lifediff.exe
fi

name="lifediff_${ver}_${goos}_${goarch}.${ext}"
url="https://github.com/${repo}/releases/download/${version}/${name}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading ${url}"
curl -fsSL "$url" -o "${tmp}/archive.${ext}"
mkdir -p "${tmp}/out"
if [ "$ext" = "zip" ]; then
  unzip -q "${tmp}/archive.${ext}" -d "${tmp}/out"
else
  tar -xzf "${tmp}/archive.${ext}" -C "${tmp}/out"
fi

# GoReleaser may put files at the archive root or under one directory.
root="${tmp}/out"
if [ ! -f "${root}/${binname}" ]; then
  nested=$(find "${tmp}/out" -type f -name "${binname}" | head -n 1)
  if [ -z "$nested" ]; then
    echo "The archive did not contain ${binname}." >&2
    exit 1
  fi
  root=$(dirname "$nested")
fi

bindir="${LIFEDIFF_BIN_DIR:-${HOME}/.local/bin}"
mkdir -p "$bindir"
if command -v install >/dev/null 2>&1; then
  install -m 755 "${root}/${binname}" "${bindir}/${binname}"
else
  cp "${root}/${binname}" "${bindir}/${binname}"
  chmod 755 "${bindir}/${binname}"
fi

skill_src=$(find "${tmp}/out" -type f -path '*/skills/life-diff/SKILL.md' | head -n 1)
if [ -z "$skill_src" ]; then
  echo "The archive did not contain skills/life-diff/SKILL.md." >&2
  exit 1
fi
skilldir="${LIFEDIFF_SKILL_DIR:-${HOME}/.cursor/skills/life-diff}"
mkdir -p "$skilldir"
cp "$skill_src" "${skilldir}/SKILL.md"
chmod 644 "${skilldir}/SKILL.md"

echo "Installed ${bindir}/${binname}"
echo "Installed the Life Diff skill at ${skilldir}/SKILL.md"
echo "Put ${bindir} on PATH if it is not already."
echo "Next: save a desktop OAuth client at ~/.lifediff/credentials.json and run lifediff auth"
