import sys
import json
import os
import argparse

def simple_fallback_search(feedback_file):
    """Fallback logic to return recent 3 if memory, load, or chroma fail"""
    if not os.path.exists(feedback_file):
        return []
    try:
        with open(feedback_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            # Just return up to 3 most recent feedback
            return data[-3:] if len(data) > 0 else [] 
    except:
        return []

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('query', type=str, nargs='?', default="", help="Text to search against past feedback")
    args = parser.parse_args()

    query_text = args.query.strip()
    feedback_file = 'user_exclusion_feedback.json'
    db_path = './chroma_db'

    # Validation: Memory/Lib Missing OOM Fallback
    try:
        import chromadb
    except ImportError:
        print(json.dumps(simple_fallback_search(feedback_file)))
        return

    try:
        if not os.path.exists(db_path):
            print(json.dumps(simple_fallback_search(feedback_file)))
            return
            
        client = chromadb.PersistentClient(path=db_path)
        
        try:
            collection = client.get_collection(name="exclusion_feedback")
        except:
            print(json.dumps(simple_fallback_search(feedback_file)))
            return

        # Validation: Empty DB Check
        if collection.count() == 0:
            print(json.dumps([]))
            return
            
        # Top 3 results incrementally fetching
        search_query = [query_text] if query_text else ["vulnerability security patch limit"]
        results = collection.query(
            query_texts=search_query,
            n_results=min(3, collection.count())
        )
        
        extracted = []
        if results and 'documents' in results and results['documents']:
            doc_group = results['documents'][0]
            meta_group = results['metadatas'][0] if results.get('metadatas') else []
            for i, doc in enumerate(doc_group):
                issue_id = meta_group[i].get("issueId", "") if i < len(meta_group) else ""
                extracted.append({
                    "reason": doc,
                    "issueId": issue_id
                })
        print(json.dumps(extracted))

    except Exception as e:
        # 3-Layer Fallback Exception: Memory exhaustion triggers simple search
        print(json.dumps(simple_fallback_search(feedback_file)))

if __name__ == "__main__":
    main()
