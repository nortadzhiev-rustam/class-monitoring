// The page shown instead of a blocked site.

const params = new URLSearchParams(location.search);
const site = params.get('site');

if (site) {
  document.getElementById('site')!.textContent = site;
} else if (params.get('mode') === 'allow') {
  document.getElementById('reason')!.textContent = "Your teacher has limited browsing to a few sites, and this isn't one of them.";
}
