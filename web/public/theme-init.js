;(() => {
  var t = localStorage.getItem('theme') || 'auto'
  var dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  var m = document.querySelector('meta[name="theme-color"]')
  if (m) m.content = dark ? '#211d1a' : '#f7f5f2'
  // Brand colour preset (§2.1): painted with the theme, before first paint, so a stored preset
  // never shows a frame of terracotta. The default preset is the absence of the attribute, and
  // an unknown value leaves it unset too — index.css falls back to the terracotta tokens.
  var themeColors = [
    'terracotta',
    'ocean',
    'teal',
    'forest',
    'grape',
    'rose',
    'royal',
    'violet',
    'tangerine',
    'cyan',
    'magenta',
    'emerald',
  ]
  var c = localStorage.getItem('theme-color')
  if (c && c !== 'terracotta' && themeColors.indexOf(c) !== -1) {
    document.documentElement.setAttribute('data-theme-color', c)
  }
})()
