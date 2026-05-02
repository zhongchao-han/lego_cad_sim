const fs = require('fs');

const path = 'frontend/src/App.jsx';
let content = fs.readFileSync(path, 'utf8');

content = content.replace('export default App;\n\nexport default function App() {', 'export default function App() {');

fs.writeFileSync(path, content);
