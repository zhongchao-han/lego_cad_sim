with open("frontend/src/App.jsx", "r") as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    if "const view = useStore((state) => state.view);" in line and "App" in "".join(new_lines[-10:]):
        # We know these hooks are used unconditionally, but the `if (window.location.pathname === '/generator')` is above them.
        # We need to move the hook declarations ABOVE the conditional return.
        pass
    new_lines.append(line)

# Let's write a targeted script to parse and fix App.jsx
