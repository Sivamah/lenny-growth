"""Verify the 6 required scenarios against the live running application.

Runs:
- Test A: General conversation ("How can I stop procrastinating and build a realistic daily routine?")
- Test B: Programming help ("Explain the difference between an array and an ArrayList in Java.")
- Test C: Transcript-grounded ("What did Jason Cohen say about pricing when a product stops growing?")
- Test D: Follow-up in same session ("Can you give me three practical examples of applying that advice?")
- Test E: Session isolation in fresh session ("How can I organize my daily timetable for deep work?")
- Test F: Unsupported transcript claim ("What did Lenny's podcast say about quantum computing algorithms?")
"""
import json
import sys
import httpx

BACKEND_URL = "http://127.0.0.1:8000"

def create_session(client: httpx.Client, title: str) -> str:
    res = client.post(f"{BACKEND_URL}/sessions", json={"title": title})
    res.raise_for_status()
    data = res.json()
    return data["id"]

def run_chat_turn(client: httpx.Client, session_id: str, prompt: str) -> dict:
    events = []
    text_deltas = []
    citations = []
    grounding = None
    turn_end = None

    url = f"{BACKEND_URL}/api/chat"
    payload = {"session_id": session_id, "message": prompt}
    with client.stream("POST", url, json=payload, timeout=90.0) as response:
        response.raise_for_status()
        current_event = None
        for line in response.iter_lines():
            line = line.strip()
            if not line:
                continue
            if line.startswith("event: "):
                current_event = line[len("event: "):].strip()
            elif line.startswith("data: "):
                data_str = line[len("data: "):].strip()
                try:
                    data = json.loads(data_str)
                except Exception:
                    data = data_str
                events.append({"event": current_event, "data": data})
                if current_event == "text_delta" and isinstance(data, dict):
                    text_deltas.append(data.get("text", ""))
                elif current_event == "citations" and isinstance(data, dict):
                    citations.extend(data.get("citations", []))
                elif current_event == "grounding" and isinstance(data, dict):
                    grounding = data
                elif current_event == "turn_end" and isinstance(data, dict):
                    turn_end = data

    full_text = "".join(text_deltas).strip()
    return {
        "text": full_text,
        "citations": citations,
        "grounding": grounding,
        "turn_end": turn_end,
        "events_count": len(events),
    }

def main():
    with httpx.Client() as client:
        print("=== VERIFYING LIVE SCENARIOS ===\n")

        # Test A: General conversation
        print("--- Test A: General Conversation ---")
        sess_a = create_session(client, "Test A - Productivity")
        prompt_a = "How can I stop procrastinating and build a realistic daily routine?"
        res_a = run_chat_turn(client, sess_a, prompt_a)
        print(f"Prompt: {prompt_a}")
        print(f"Citations count: {len(res_a['citations'])}")
        print(f"Grounding: {res_a['grounding']}")
        print(f"Response preview: {res_a['text'][:250]}...")
        assert len(res_a['citations']) == 0, "Test A should have NO citations"
        assert res_a['grounding'] is None, "Test A should have NO grounding tag"
        assert "based on the search transcript" not in res_a['text'].lower(), "Test A must not cite transcripts"
        print("[PASS] Test A PASSED\n")

        # Test B: Programming help
        print("--- Test B: Programming Help ---")
        sess_b = create_session(client, "Test B - Java")
        prompt_b = "Explain the difference between an array and an ArrayList in Java."
        res_b = run_chat_turn(client, sess_b, prompt_b)
        print(f"Prompt: {prompt_b}")
        print(f"Citations count: {len(res_b['citations'])}")
        print(f"Grounding: {res_b['grounding']}")
        print(f"Response preview: {res_b['text'][:250]}...")
        assert len(res_b['citations']) == 0, "Test B should have NO citations"
        assert res_b['grounding'] is None, "Test B should have NO grounding tag"
        assert "array" in res_b['text'].lower(), "Test B must explain arrays"
        print("[PASS] Test B PASSED\n")

        # Test C: Transcript-grounded (Jason Cohen pricing)
        print("--- Test C: Transcript-grounded ---")
        sess_c = create_session(client, "Test C - Jason Cohen")
        prompt_c = "What did Jason Cohen say about pricing when a product stops growing?"
        res_c = run_chat_turn(client, sess_c, prompt_c)
        print(f"Prompt: {prompt_c}")
        print(f"Citations count: {len(res_c['citations'])}")
        print(f"Grounding: {res_c['grounding']}")
        if res_c['citations']:
            guests = [c.get('guest') for c in res_c['citations']]
            episodes = [c.get('episode') for c in res_c['citations']]
            print(f"Cited guests: {guests}")
            print(f"Cited episodes: {episodes}")
        print(f"Response preview: {res_c['text'][:250]}...")
        assert len(res_c['citations']) > 0, "Test C must have citations"
        assert res_c['grounding'] is not None and res_c['grounding'].get('grounded') is True, "Test C must be grounded"
        assert any("jason cohen" in str(c.get('guest', '')).lower() for c in res_c['citations']), "Test C citations must include Jason Cohen"
        print("[PASS] Test C PASSED\n")

        # Test D: Follow-up in same session
        print("--- Test D: Follow-up in Same Session ---")
        prompt_d = "Can you give me three practical examples of applying that advice?"
        res_d = run_chat_turn(client, sess_c, prompt_d)
        print(f"Prompt: {prompt_d}")
        print(f"Citations count: {len(res_d['citations'])}")
        print(f"Grounding: {res_d['grounding']}")
        print(f"Response preview: {res_d['text'][:250]}...")
        assert len(res_d['citations']) == 0, "Test D follow-up should not introduce new random citations"
        print("[PASS] Test D PASSED\n")

        # Test E: Session isolation in fresh session
        print("--- Test E: Session Isolation in Fresh Session ---")
        sess_e = create_session(client, "Test E - Fresh Session")
        prompt_e = "How can I organize my daily timetable for deep work?"
        res_e = run_chat_turn(client, sess_e, prompt_e)
        print(f"Prompt: {prompt_e}")
        print(f"Citations count: {len(res_e['citations'])}")
        print(f"Grounding: {res_e['grounding']}")
        print(f"Response preview: {res_e['text'][:250]}...")
        assert len(res_e['citations']) == 0, "Test E in new session must have NO citations"
        assert res_e['grounding'] is None, "Test E must have NO grounding tag"
        assert "jason cohen" not in res_e['text'].lower(), "Test E must not leak Jason Cohen context"
        print("[PASS] Test E PASSED\n")

        # Test F: Unsupported transcript claim
        print("--- Test F: Unsupported Transcript Claim ---")
        sess_f = create_session(client, "Test F - Unsupported Claim")
        prompt_f = "What did Lenny's podcast say about quantum computing algorithms?"
        res_f = run_chat_turn(client, sess_f, prompt_f)
        print(f"Prompt: {prompt_f}")
        print(f"Citations count: {len(res_f['citations'])}")
        print(f"Grounding: {res_f['grounding']}")
        print(f"Response preview: {res_f['text'][:250]}...")
        assert len(res_f['citations']) == 0, "Test F must NOT have fabricated citations"
        assert res_f['grounding'] is not None and res_f['grounding'].get('grounded') is False, "Test F must be ungrounded"
        print("[PASS] Test F PASSED\n")

        print("=== ALL 6 LIVE SCENARIOS VERIFIED SUCCESSFULLY! ===")

if __name__ == "__main__":
    main()
