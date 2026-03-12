import json

target_ids = ['ELSA-2026-2786', 'USN-8062-1-24.04_LTS', 'RHSA-2026:3291', 'RHSA-2026:2819']

with open('/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/patches_for_llm_review.json') as f:
    data = json.load(f)

for p in data:
    if p.get('id') in target_ids:
        print(f"\n==================================================\nID: {p['id']}\nComponent: {p.get('component')}")
        
        # We need to find the lines containing the expected version string
        text = p.get('full_text', '')
        lines = text.split('\n')
        
        print("--- MATCHING LINES ---")
        for line in lines:
            if 'glibc-2.34-231.0.1.el9_7.10' in line or \
               '8.5.0-2ubuntu10.7' in line or \
               'runc-1.4.0-2.el9_7' in line or \
               'pcs-0.11.4-7.el9_2.7' in line:
                print(line.strip()[:150])

            if 'curl' in line.lower() and ('8.5.0' in line or '7.81' in line):
                print(f"CURL MENTION: {line.strip()[:150]}")
