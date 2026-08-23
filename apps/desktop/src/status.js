window.harnessDesktop.onStatus(({ message, detail }) => {
  document.querySelector('#message').textContent = message
  document.querySelector('#detail').textContent = detail || ''
})
