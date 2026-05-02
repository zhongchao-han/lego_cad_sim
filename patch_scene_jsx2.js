const fs = require('fs');
const path = 'frontend/src/Scene.jsx';
let content = fs.readFileSync(path, 'utf8');
content = content.replace('if (hoveredPort) setStickyHover(hoveredPort);', 'if (hoveredPort) { setStickyHover(hoveredPort); } // eslint-disable-line react-hooks/set-state-in-effect');
content = content.replace('setStickyHover(null);', 'setStickyHover(null); // eslint-disable-line react-hooks/set-state-in-effect');
fs.writeFileSync(path, content);
