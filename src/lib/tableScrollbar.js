// Table-local visibility only: native scrolling/selection stay untouched.
// Window listeners exist only while the native horizontal bar is held.
export function bindTableScrollbar(element, delay = 900) {
  const win = element.ownerDocument.defaultView
  const visibleClass = 'knote-table-scroll-visible'
  let timer = null, hovered = false, pressed = false
  const setVisible = value => {
    if (element.classList.contains(visibleClass) !== value) element.classList.toggle(visibleClass, value)
  }
  const clear = () => { if (timer !== null) win.clearTimeout(timer); timer = null }
  const hideLater = () => {
    clear()
    if (!hovered && !pressed) timer = win.setTimeout(() => { timer = null; setVisible(false) }, delay)
  }
  const show = () => { clear(); setVisible(true) }
  const enter = () => { hovered = true; show() }
  const leave = () => { hovered = false; hideLater() }
  const scroll = () => { show(); hideLater() }
  const detachPress = () => {
    win.removeEventListener('mouseup', release, true)
    win.removeEventListener('pointerup', release, true)
    win.removeEventListener('pointercancel', release, true)
    win.removeEventListener('blur', release)
  }
  const release = event => {
    if (!pressed) return
    pressed = false
    detachPress()
    const box = element.getBoundingClientRect()
    hovered = event.type !== 'blur' && event.type !== 'pointercancel' &&
      event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom
    hideLater()
  }
  const down = event => {
    if (event.button !== 0 || event.target !== element || element.scrollWidth <= element.clientWidth) return
    const box = element.getBoundingClientRect()
    const barTop = box.top + element.clientTop + element.clientHeight
    if (event.clientY < barTop || event.clientY >= box.bottom || event.clientX < box.left || event.clientX >= box.right) return
    pressed = true
    show()
    win.addEventListener('mouseup', release, true)
    win.addEventListener('pointerup', release, true)
    win.addEventListener('pointercancel', release, true)
    win.addEventListener('blur', release)
  }
  element.setAttribute('data-knote-local-scrollbar', 'table')
  element.addEventListener('mouseenter', enter)
  element.addEventListener('mouseleave', leave)
  element.addEventListener('mousedown', down)
  element.addEventListener('scroll', scroll, { passive: true })
  return () => {
    clear(); detachPress()
    element.removeEventListener('mouseenter', enter)
    element.removeEventListener('mouseleave', leave)
    element.removeEventListener('mousedown', down)
    element.removeEventListener('scroll', scroll)
    element.removeAttribute('data-knote-local-scrollbar')
    element.classList.remove(visibleClass)
  }
}
