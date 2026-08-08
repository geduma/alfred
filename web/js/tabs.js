(function () {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');

  function activate(tab) {
    const name = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    panels.forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => activate(tab)));
})();
