#!/bin/bash
mkdir -p oracle_data
echo "🚀 Oracle Collector FULL (BaseOS + UEK + AppStream OL8+) 시작"

declare -A UEK_REPOS
UEK_REPOS[7]="UEKR6"
UEK_REPOS[8]="UEKR7"
UEK_REPOS[9]="UEKR7 UEKR8"
UEK_REPOS[10]="UEKR8"

for OL_VERSION in 7 8 9 10; do
    echo "========================================"
    echo "🔄 Oracle Linux ${OL_VERSION} 처리 중..."

    # ==================== BaseOS ====================
    if [ "$OL_VERSION" -le 7 ]; then SUBPATH="latest"; else SUBPATH="baseos/latest"; fi
    REPO_BASE="https://yum.oracle.com/repo/OracleLinux/OL${OL_VERSION}/${SUBPATH}/x86_64"
    echo "   📥 BaseOS updateinfo 다운로드..."
    curl -s -o repomd.xml "${REPO_BASE}/repodata/repomd.xml"
    python3 -c '
import xml.etree.ElementTree as ET, urllib.request, sys
try:
    tree = ET.parse("repomd.xml")
    root = tree.getroot()
    ns = {"r": "http://linux.duke.edu/metadata/repo"}
    href = None
    for data in root.findall(".//r:data", ns):
        if data.get("type") == "updateinfo":
            loc = data.find("r:location", ns)
            if loc is not None: href = loc.get("href"); break
    if href:
        url = f"https://yum.oracle.com/repo/OracleLinux/OL'"${OL_VERSION}"'/'"${SUBPATH}"'/x86_64/" + href
        urllib.request.urlretrieve(url, "updateinfo.xml.gz")
        print("   ✅ BaseOS 다운로드 완료")
    else:
        print("   ⚠️ BaseOS updateinfo 없음")
except Exception as e:
    print("   ❌ BaseOS 다운로드 실패:", e)
'
    echo "   🔄 BaseOS JSON 생성..."
    python3 oracle_parser.py updateinfo.xml.gz "$OL_VERSION" "RHCK" "BaseOS" 2>/dev/null || echo "   ⚠️ BaseOS 파싱 스킵"
    rm -f repomd.xml updateinfo.xml.gz

    # ==================== UEK ====================
    for uek in ${UEK_REPOS[$OL_VERSION]}; do
        REPO_BASE="https://yum.oracle.com/repo/OracleLinux/OL${OL_VERSION}/${uek}/x86_64"
        echo "   📥 UEK(${uek}) updateinfo 다운로드..."
        curl -s -o repomd.xml "${REPO_BASE}/repodata/repomd.xml"
        python3 -c '
import xml.etree.ElementTree as ET, urllib.request, sys
try:
    tree = ET.parse("repomd.xml")
    root = tree.getroot()
    ns = {"r": "http://linux.duke.edu/metadata/repo"}
    href = None
    for data in root.findall(".//r:data", ns):
        if data.get("type") == "updateinfo":
            loc = data.find("r:location", ns)
            if loc is not None: href = loc.get("href"); break
    if href:
        url = f"https://yum.oracle.com/repo/OracleLinux/OL'"${OL_VERSION}"'/'"${uek}"'/x86_64/" + href
        urllib.request.urlretrieve(url, "updateinfo.xml.gz")
        print("   ✅ UEK('${uek}') 다운로드 완료")
    else:
        print("   ⚠️ UEK('${uek}') updateinfo 없음")
except Exception as e:
    print("   ❌ UEK('${uek}') 다운로드 실패:", e)
'
        days=90
        if [ "$OL_VERSION" = "7" ] && [ "$uek" = "UEKR6" ]; then days=180; echo "   📅 OL7 UEKR6(5.4) 180일 적용"; fi
        echo "   🔄 UEK(${uek}) JSON 생성..."
        python3 oracle_parser.py updateinfo.xml.gz "$OL_VERSION" "UEK" "UEK-${uek}" $days 2>/dev/null || echo "   ⚠️ UEK 파싱 스킵"
        rm -f repomd.xml updateinfo.xml.gz
    done

    # ==================== AppStream (OL8 이상만) ====================
    if [ "$OL_VERSION" -ge 8 ]; then
        REPO_BASE="https://yum.oracle.com/repo/OracleLinux/OL${OL_VERSION}/appstream/x86_64"
        echo "   📥 AppStream updateinfo 다운로드..."
        curl -s -o repomd.xml "${REPO_BASE}/repodata/repomd.xml"
        python3 -c '
import xml.etree.ElementTree as ET, urllib.request, sys
try:
    tree = ET.parse("repomd.xml")
    root = tree.getroot()
    ns = {"r": "http://linux.duke.edu/metadata/repo"}
    href = None
    for data in root.findall(".//r:data", ns):
        if data.get("type") == "updateinfo":
            loc = data.find("r:location", ns)
            if loc is not None: href = loc.get("href"); break
    if href:
        url = f"https://yum.oracle.com/repo/OracleLinux/OL'"${OL_VERSION}"'/appstream/x86_64/" + href
        urllib.request.urlretrieve(url, "updateinfo.xml.gz")
        print("   ✅ AppStream 다운로드 완료")
    else:
        print("   ⚠️ AppStream updateinfo 없음")
except Exception as e:
    print("   ❌ AppStream 다운로드 실패:", e)
'
        echo "   🔄 AppStream JSON 생성..."
        python3 oracle_parser.py updateinfo.xml.gz "$OL_VERSION" "AppStream" "AppStream" 2>/dev/null || echo "   ⚠️ AppStream 파싱 스킵"
        rm -f repomd.xml updateinfo.xml.gz
    else
        echo "   ⏭️ OL7 AppStream은 존재하지 않아 스킵합니다 (optional/latest가 별도)"
    fi
done

echo "========================================"
echo "🎉 모든 작업 완료! (AppStream OL8~OL10 포함)"
echo "   총 파일 수: $(ls oracle_data/ 2>/dev/null | wc -l)"
