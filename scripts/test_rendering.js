const fs = require('fs');

const jsonPath = 'data/ldraw_port_configs.json';
const db = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const partData = db['parts/64179.dat'];

const sites = partData.sites || [];
console.log(`Total sites: ${sites.length}`);

function isHoleType(type, gender) {
  if (gender) return gender === 'FEMALE';
  const t = type.toLowerCase();
  return t.includes('hole') || t.includes('hol') || t === 'peghole' || t === 'axlehole';
}

let renderedArrows = 0;
for (const site of sites) {
    for (const port of site.ports) {
        if (isHoleType(port.type, port.gender)) {
            if (port.name.includes("healed")) {
                 console.log(`[HEALED] Pos: ${port.position}, Z-Dir: [${port.rotation[0][2]}, ${port.rotation[1][2]}, ${port.rotation[2][2]}]`);
            }
            renderedArrows++;
        }
    }
}

console.log(`Total arrows that SHOULD render: ${renderedArrows}`);
