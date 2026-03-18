import json

file_path = "/home/citec/.openclaw/workspace/skills/patch-review/os/linux/patches_for_llm_review.json"
try:
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    print("Empty RHEL:")
    for p in data:
        if p['vendor'] == 'Red Hat' and p['dist_version'] == '':
            print("  ", p['id'], "Product:", p.get('affected_products', []))
            
    print("\nEmpty Ubuntu:")
    for p in data:
        if p['vendor'] == 'Canonical / Ubuntu' or p['vendor'] == 'Ubuntu':
            if p['dist_version'] == 'Unknown' or p['dist_version'] == '':
                print("  ", p['id'])

except Exception as e:
    print(f"Error: {e}")
