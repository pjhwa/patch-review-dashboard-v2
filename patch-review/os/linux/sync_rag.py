import sys
import json
import os
import traceback

def load_data(file_path):
    if not os.path.exists(file_path):
        return []
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading {file_path}: {e}")
        return []

def main():
    feedback_file = 'user_exclusion_feedback.json'
    db_path = './chroma_db'
    
    # Validation 1: Check Empty DB
    data = load_data(feedback_file)
    if not data:
        print("No feedback data found or file is empty.")
        sys.exit(0)

    try:
        import chromadb
    except ImportError:
        print("ChromaDB not installed. Skipping RAG sync.")
        sys.exit(0)

    # Validation 2: Handle Memory Limits / OOM issues during Chroma DB init
    try:
        client = chromadb.PersistentClient(path=db_path)
        collection = client.get_or_create_collection(
            name="exclusion_feedback",
            metadata={"hnsw:space": "cosine"}
        )
        
        # Incremental UPSERT handling
        ids = []
        documents = []
        metadatas = []
        
        for item in data:
            issue_id = item.get('issueId', '')
            if not issue_id:
                issue_id = item.get('id', str(hash(json.dumps(item)))) # fallback ID
            
            doc_str = f"Issue: {issue_id}\nComponent: {item.get('component', '')}\nDescription: {item.get('description', '')}\nReason: {item.get('reason', '')}"
            ids.append(issue_id)
            documents.append(doc_str)
            metadatas.append({"issueId": issue_id})
        
        if documents:
            collection.upsert(
                documents=documents,
                ids=ids,
                metadatas=metadatas
            )
            print(f"Successfully upserted {len(documents)} logic patterns into ChromaDB.")
    except Exception as e:
        # Fallback executed in outer runner or here (silent fallback logs)
        print(f"Failed to sync ChromaDB (Possible OOM or Storage Lock): {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
