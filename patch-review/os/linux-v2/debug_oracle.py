import json
import glob
import re

for f in glob.glob("/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/batch_data/*.json"):
    with open(f, 'r') as jf:
        data = json.load(jf)
        if not isinstance(data, dict):
            continue
        patch_id = data.get('id', '')
        if patch_id in ['USN-7851-2', 'RHSA-2026:1733', 'ELBA-2026-2413'] or '019563' in f or '019574' in f or 'kpartx' in f:
            print(f"\n--- {patch_id} ({f}) ---")
            print("TITLE:", data.get('title', ''))
            print("SYNOPSIS/OVERVIEW:", data.get('synopsis', ''), data.get('summary', ''), data.get('overview', ''))
            
            # Print Red Hat specifics if applicable
            if 'RHSA' in patch_id:
                print("AFFECTED PRODUCTS:", data.get('affected_products', []))
