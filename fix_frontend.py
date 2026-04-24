import re

def fix():
    path = "frontend/src/App.jsx"
    with open(path, "r") as f:
        content = f.read()

    # Create a MainApp component
    content = content.replace("function App() {", "function MainApp() {\n")

    # App component that handles routing
    app_wrapper = """
export default function App() {
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }
  return <MainApp />;
}
"""

    # Remove the early return from MainApp
    content = content.replace("""  // 神器级别无侵入拦截：隔离离线 GPU 提图工具引擎，严禁污染主应用状态树
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }""", "")

    # Replace export default App; with our app_wrapper
    content = content.replace("export default App;", app_wrapper)

    with open(path, "w") as f:
        f.write(content)

fix()
