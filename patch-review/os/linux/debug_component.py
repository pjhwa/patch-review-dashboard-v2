import json
import glob
import re

for f in glob.glob("/home/citec/.openclaw/workspace/skills/patch-review/os/linux/batch_data/*.json"):
    with open(f, 'r') as jf:
        data = json.load(jf)
        if not isinstance(data, dict): continue
        if '019563' in f or '019574' in f or 'USN-7851' in f or 'RHSA-2026_1733' in f:
            print(f"--- F: {f} ---")
            print("TITLE:", data.get('title', ''))
            print("SYNOPSIS:", data.get('synopsis', ''))
            print("OVERVIEW:", data.get('overview', ''))
            print("AFFECTED:", data.get('affected_products', []))
            
            # Print the first few words of the synopsis to see the pattern
            synopsis = data.get('synopsis', '')
            if synopsis.startswith('[El-errata]'):
                m = re.search(r'Oracle Linux \d+ ([\w-]+) ', synopsis)
                if m:
                    print("EXTRACTED COMPONENT:", m.group(1))
