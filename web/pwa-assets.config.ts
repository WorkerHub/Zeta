import { defineConfig } from '@vite-pwa/assets-generator/config'

/**
 * Home-screen icon set, generated from `public/pwa/app-icon.svg` by `pnpm pwa:icons`.
 *
 * The source is already a full-bleed terracotta tile with the mark at 56% of it, so every entry
 * uses `padding: 0`: the geometry of the source is what ships. That keeps all four PNGs opaque
 * (iOS paints a transparent apple-touch-icon black) and leaves ~22% clear space on each side,
 * inside the maskable safe zone. The generated PNGs are committed, so the build never runs this.
 */
export default defineConfig({
  preset: {
    assetName: (type, size) => {
      const base = { transparent: 'icon', maskable: 'maskable', apple: 'apple-touch-icon' }[type]
      return `${base}-${size.width}x${size.height}.png`
    },
    transparent: { sizes: [192, 512], padding: 0 },
    maskable: { sizes: [512], padding: 0, resizeOptions: { fit: 'contain', background: '#C25E3F' } },
    apple: { sizes: [180], padding: 0, resizeOptions: { fit: 'contain', background: '#C25E3F' } },
  },
  images: ['public/pwa/app-icon.svg'],
})
