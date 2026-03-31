import fs from 'fs';
import path from 'path';

// read the json db directly
const jsonPath = path.resolve(__dirname, '../../../../data/ldraw_port_configs.json');
const db = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const partData = db['parts/64179.dat'];

if (!partData) {
    console.error("64179.dat not found in DB!");
    process.exit(1);
}

const sites = partData.sites || [];
console.log(`Total sites in DB for 64179: ${sites.length}`);

// Simulating SiteGizmo `isHoleType` logic:
function isHoleType(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes('hole') || t.includes('hol') || t === 'peghole' || t === 'axlehole';
}

function processGizmos() {
    let renderedArrows = 0;
    
    for (const site of sites) {
        for (const port of site.ports) {
            const compatible = true; // Always true in IDLE without strict target
            if (compatible) {
                // Determine color
                const color = isHoleType(port.type) ? 'blue' : 'purple';
                
                // Print the details
                if (port.name.includes("healed")) {
                     console.log(`[HEALED] Rendered Arrow -> Port: ${port.name}, Pos: ${port.position}, Z-Dir: [${port.rotation[0][2]}, ${port.rotation[1][2]}, ${port.rotation[2][2]}], Color: ${color}`);
                }
                renderedArrows++;
            }
        }
    }
    
    console.log(`Total arrows that WOULD be rendered by React: ${renderedArrows}`);
}

processGizmos();
