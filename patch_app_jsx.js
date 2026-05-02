const fs = require('fs');

const path = 'frontend/src/App.jsx';
let content = fs.readFileSync(path, 'utf8');

// The early return `if (window.location.pathname === '/generator')` is causing the rules-of-hooks error
// We need to extract the main app into a subcomponent or move the hooks.
// Let's create an intermediate component MainApp, and App simply switches between MainApp and ThumbnailGenerator.

let mainAppCode = content.replace(/export default function App\(\) \{/, `function MainApp() {`);
mainAppCode = mainAppCode.replace(`  // 神器级别无侵入拦截：隔离离线 GPU 提图工具引擎，严禁污染主应用状态树
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }
`, '');
mainAppCode += `

export default function App() {
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }
  return <MainApp />;
}
`;

fs.writeFileSync(path, mainAppCode);
