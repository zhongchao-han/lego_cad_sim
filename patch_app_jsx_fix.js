const fs = require('fs');

const path = 'frontend/src/App.jsx';
let content = fs.readFileSync(path, 'utf8');

content = content.replace('function App() {', 'function MainApp() {');

fs.writeFileSync(path, content);
