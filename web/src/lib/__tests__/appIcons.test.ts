import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The committed home-screen icon set (public/pwa/) is what the manifest and index.html point at,
// and nothing regenerates it at build time — a bad `pnpm pwa:icons` run would ship silently. These
// checks pin the two properties that matter: the pixel size the manifest declares, and an opaque
// image (iOS paints a transparent apple-touch-icon with black).
const ICONS = [
  { file: 'icon-192x192.png', size: 192 },
  { file: 'icon-512x512.png', size: 512 },
  { file: 'maskable-512x512.png', size: 512 },
  { file: 'apple-touch-icon-180x180.png', size: 180 },
] as const

const PWA_DIR = fileURLToPath(new URL('../../../public/pwa/', import.meta.url))

// PNG structure: 8-byte signature, then length (4) + type (4) + data + CRC (4) per chunk. IHDR is
// always first and carries width/height/bit depth/colour type; a tRNS chunk is the only other way
// to describe transparency.
function png(file: string) {
  const bytes = readFileSync(PWA_DIR + file)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const chunks: string[] = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1')
    chunks.push(type)
    if (type === 'IEND') break
    offset += 12 + length
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    chunks,
  }
}

describe('home-screen icons', () => {
  for (const { file, size } of ICONS) {
    it(`${file} is a ${size}×${size} opaque PNG`, () => {
      const image = png(file)
      expect([image.width, image.height]).toEqual([size, size])
      expect(image.bitDepth).toBe(8)
      // Colour types 4 (grey+alpha) and 6 (RGB+alpha) carry an alpha channel; anything else is
      // opaque as long as there is no tRNS chunk (which indexed and truecolour images may add).
      expect([4, 6]).not.toContain(image.colorType)
      expect(image.chunks).not.toContain('tRNS')
    })
  }
})
