const fs = require('fs');
const path = require('path');

const jsonPath = path.resolve(__dirname, '../../../../data/ldraw_port_configs.json');
const db = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const partData = db['parts/64179.dat'];

if (!partData) {
    console.error("64179.dat not found in DB!");
    process.exit(1);
}

const sites = partData.sites || [];
console.log(`Total sites in DB for 64179: ${sites.length}`);

function isHoleType(type, gender) {
  if (gender) return gender === 'FEMALE';
  const t = type.toLowerCase();
  return t.includes('hole') || t.includes('hol') || t === 'peghole' || t === 'axlehole';
}

function processGizmos() {
    let renderedArrows = 0;
    
    for (const site of sites) {
        for (const port of site.ports) {
            const compatible = true; 
            if (compatible) {
                const color = isHoleType(port.type, port.gender) ? 'blue' : 'purple';
                
                if (port.name.includes("healed")) {
                     console.log(`[HEALED] Arrow -> Port: ${port.name}, Pos: ${port.position}, Z-Dir: [${port.rotation[0][2]}, ${port.rotation[1][2]}, ${port.rotation[2][2]}], Color: ${color}`);
                }
                renderedArrows++;
            }
        }
    }
    
    console.log(`Total arrows that WOULD be rendered: ${renderedArrows}`);
}

processGizmos();
