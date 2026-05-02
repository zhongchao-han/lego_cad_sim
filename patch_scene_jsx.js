const fs = require('fs');
const path = 'frontend/src/Scene.jsx';
let content = fs.readFileSync(path, 'utf8');
content = content.replace('// eslint-disable-next-line react-hooks/set-state-in-effect\n        if (hoveredPort)', 'if (hoveredPort)');
content = content.replace('// eslint-disable-next-line react-hooks/set-state-in-effect\n        setStickyHover(null);', 'setStickyHover(null);');
fs.writeFileSync(path, content);
