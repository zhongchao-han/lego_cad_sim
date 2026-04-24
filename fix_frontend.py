import re

def fix():
    path = "frontend/src/App.jsx"
    with open(path, "r") as f:
        content = f.read()

    # Apply the fix properly
    content = content.replace("function App() {", "function MainApp() {")

    app_wrapper = """
export default function App() {
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }
  return <MainApp />;
}
"""
    content = content.replace("""  // 神器级别无侵入拦截：隔离离线 GPU 提图工具引擎，严禁污染主应用状态树
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }""", "")

    content = content.replace("export default App;", app_wrapper)

    with open(path, "w") as f:
        f.write(content)

fix()
