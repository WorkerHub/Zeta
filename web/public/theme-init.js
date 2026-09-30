(function () {
  var t = localStorage.getItem('theme') || 'auto'
  var dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  var m = document.querySelector('meta[name="theme-color"]')
  if (m) m.content = dark ? '#09090b' : '#fafafa'
})()
