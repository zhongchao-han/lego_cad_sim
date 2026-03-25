import os
import json

def cleanup():
    config_path = os.path.join("data", "ldraw_port_configs.json")
    if not os.path.exists(config_path):
        print(f"Error: {config_path} not found.")
        return

    print(f"Loading {config_path} for cleanup...")
    with open(config_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    removed_count = 0
    for part_id, config in data.items():
        if "ports" in config:
            config.pop("ports")
            removed_count += 1

    if removed_count > 0:
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"Successfully removed 'ports' field from {removed_count} parts. JSON is now strictly Site-based.")
    else:
        print("No cleanup needed.")

if __name__ == "__main__":
    cleanup()
