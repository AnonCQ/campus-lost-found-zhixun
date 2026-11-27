"""
Backend Smoke & Integration Verification Suite
Tests:
1. SQLite DB initialization & deterministic 16-item seed with real OpenCLIP 512D embeddings
2. Real Ultralytics YOLO26n + OpenCLIP ViT-B/32 recognition on seed photos
3. Offline 3-strategy benchmark evaluation across all 3 datasets
4. FastAPI TestClient verification of /api/health, /api/bundle, /api/analytics/overview, /api/auth/password-login
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from backend.ai_engine import ai_engine
from backend.database import SessionLocal, init_db
from backend.evaluation_service import run_dataset_evaluation
from backend.main import app
from backend.seed_service import execute_deterministic_seed


def main():
    print("1. Initializing SQLite DB & seeding with real OpenCLIP ViT-B/32 512D vectors...")
    init_db()
    with SessionLocal() as db:
        seed_res = execute_deterministic_seed(db, mode="reset")
    print("   SEED RESULT:", seed_res)
    assert seed_res["itemCount"] == 16
    assert seed_res["embeddingDimension"] == 512

    print("2. Testing real YOLO26n + OpenCLIP recognition...")
    rec1 = ai_engine.recognize_image(
        image_url="/images/item_silver_macbook_pro_1794213311172.jpg",
        title="银色 MacBook Pro",
        description="图书馆四楼",
    )
    print(
        f"   MacBook -> raw={rec1['rawModelClass']}, cat={rec1['mappedCampusCategory']}, "
        f"conf={rec1['confidence']}, bbox={rec1['bbox']}, color={rec1['color']}, {rec1['latencyMs']}ms"
    )
    assert rec1["mappedCampusCategory"] == "数码电子"

    rec2 = ai_engine.recognize_image(
        image_url="/images/item_blue_campus_card_1794213313422.jpg",
        title="蓝色校园一卡通",
        description="一食堂二楼",
    )
    print(
        f"   Campus Card -> raw={rec2['rawModelClass']}, cat={rec2['mappedCampusCategory']}, "
        f"conf={rec2['confidence']}, color={rec2['color']}, {rec2['latencyMs']}ms"
    )
    assert rec2["mappedCampusCategory"] == "证件卡类"

    print("3. Testing offline 3-strategy evaluation benchmark...")
    for key in ("dataset", "dataset_control", "dataset_blind"):
        rep = run_dataset_evaluation(key)
        s3 = rep["strategies"][2]
        print(
            f"   [{key}] ({rep['datasetSize']} pairs) 3-Way Rerank: "
            f"P={s3['precision']}% R={s3['recall']}% F1={s3['f1']}% "
            f"R@1={s3['recallAt1']}% R@3={s3['recallAt3']}% R@5={s3['recallAt5']}%"
        )

    print("4. Testing FastAPI HTTP endpoints via TestClient...")
    client = TestClient(app)
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    h = r_health.json()
    print(f"   /api/health -> {h['backendFramework']} | DB={h['databaseEngine']} | GPU={h['gpuName']} | YOLO={h['yoloModel']}")

    r_bundle = client.get("/api/bundle")
    assert r_bundle.status_code == 200
    b = r_bundle.json()
    print(f"   /api/bundle -> users={len(b['users'])}, items={len(b['items'])}, embs={len(b['embeddings'])}, matches={len(b['matches'])}")
    assert len(b["items"]) == 16
    assert len(b["matches"]) == 6

    r_login = client.post("/api/auth/password-login", json={"account": "2023010982", "password": "cqca123456"})
    assert r_login.status_code == 200 and r_login.json()["ok"] is True
    print(f"   /api/auth/password-login -> OK ({r_login.json()['user']['displayName']})")

    r_ana = client.get("/api/analytics/overview")
    assert r_ana.status_code == 200
    print(f"   /api/analytics/overview -> categories={len(r_ana.json()['categoryDistribution'])}, locations={len(r_ana.json()['locationHotspots'])}")

    r_rag = client.post("/api/rag/query", json={"query": "校园一卡通丢了怎么挂失补办", "topK": 3})
    assert r_rag.status_code == 200 and len(r_rag.json()["knowledgeHits"]) >= 1
    print(f"   /api/rag/query -> topKB='{r_rag.json()['knowledgeHits'][0]['title']}' (score={r_rag.json()['knowledgeHits'][0]['score']}), visualHits={len(r_rag.json()['crossModalVisualHits'])}")

    r_agent = client.post(
        "/api/agent/chat",
        json={
            "messages": [{"role": "user", "content": "我的校园一卡通在食堂丢了怎么挂失补办？"}],
            "currentUser": {"uid": "demo_student_li", "displayName": "李明轩", "role": "student"},
        },
    )
    assert r_agent.status_code == 200
    ag = r_agent.json()
    print(
        f"   /api/agent/chat -> provider={ag['provider']} model={ag['model']} "
        f"tools={[t['tool'] for t in ag['toolTraces']]} ragHits={len(ag.get('ragSources') or [])} "
        f"replyLen={len(ag['reply'])}"
    )

    print("ALL BACKEND CHECKS PASSED!")


if __name__ == "__main__":
    main()
