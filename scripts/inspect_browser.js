const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log("Navigating to local dev server...");
  try {
      await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  } catch(e) {
      console.log("Try localhost");
      await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  }

  console.log("Evaluating fetch exactly as useLDrawPart does...");
  
  const siteData = await page.evaluate(async () => {
      try {
          const res = await fetch('http://127.0.0.1:8000/api/ldraw_part/64179.dat?color=7&include_pending=false&_t=' + Date.now());
          const json = await res.json();
          return {
              sitesLength: json.sites ? json.sites.length : 0,
              healedSites: json.sites ? json.sites.filter(s => s.ports.some(p => p.name.includes('healed'))).length : 0,
              firstHealed: json.sites ? json.sites.find(s => s.ports.some(p => p.name.includes('healed'))) : null
          };
      } catch (err) {
          return { error: err.toString() };
      }
  });
  
  console.log("FETCH RESULT:");
  console.log(JSON.stringify(siteData, null, 2));

  await browser.close();
})();
