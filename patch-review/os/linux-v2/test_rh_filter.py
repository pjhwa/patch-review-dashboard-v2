import json
import glob
import re
import sys

sys.path.append('/home/citec/.openclaw/workspace/skills/patch-review/os/linux')

files = sorted(glob.glob('/home/citec/.openclaw/workspace/skills/patch-review/os/linux/batch_data/RHSA-*.json'))[-100:]
kept = 0
reasons = {}

for f in files:
    try:
        data = json.load(open(f))
        vendor = data.get('vendor', '')
        severity = data.get('severity', '')
        affected_products = data.get('affected_products', [])
        
        # Rule 2: Severity
        if severity:
            sev_lower = severity.lower()
            if "moderate" in sev_lower or "low" in sev_lower:
                reasons[data['id']] = f"Dropped: Severity {severity}"
                continue
                
        # Rule 3: Product Validation
        if vendor == "Red Hat":
            if not isinstance(affected_products, list) or len(affected_products) == 0:
                reasons[data['id']] = f"Dropped: affected_products empty or not list"
                continue
                
            has_valid_product = False
            matched_prod = ""
            for prod in affected_products:
                if re.search(r'Red Hat Enterprise Linux.*?(?:[89]|10)\b', prod) or "Update Services for SAP Solutions" in prod:
                    has_valid_product = True
                    matched_prod = prod
                    break
            if not has_valid_product:
                reasons[data['id']] = f"Dropped: Product Validation Failed. Sample prod: {affected_products[0] if affected_products else 'none'}"
                continue
                
        reasons[data['id']] = f"KEPT (Severity: {severity}, Product matched: {matched_prod})"
        kept += 1
    except Exception as e:
        reasons[f] = f"Error: {str(e)}"

for k, v in list(reasons.items())[-20:]:
    print(f"{k}: {v}")
print(f"\nTotal KEPT out of 100: {kept}")
