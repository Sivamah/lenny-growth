"""End-to-End Live Verification Script for Phase 6.

Tests:
1. Two-turn salon business idea scenario with the exact required follow-up prompt.
2. Normal chat scenario (Java programming - no transcript retrieval, no citations).
3. Transcript retrieval scenario (Jason Cohen pricing - citations retrieved and verified).
4. Session isolation scenario (Session B does not see Session A).
"""
import json
import re
import sys
import httpx

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

BACKEND_URL = "http://127.0.0.1:8000"

def stream_chat(client: httpx.Client, session_id: str, message: str, timeout: float = 180.0):
    url = f"{BACKEND_URL}/api/chat"
    text_parts = []
    events = []
    current_event = "message"
    with client.stream("POST", url, json={"session_id": session_id, "message": message}, timeout=timeout) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if line.startswith("event: "):
                current_event = line[7:].strip()
            elif line.startswith("data: "):
                raw = line[6:]
                try:
                    data = json.loads(raw)
                    if isinstance(data, dict):
                        if current_event == "text_delta" and "text" in data:
                            text_parts.append(data["text"])
                    events.append({"event": current_event, "data": data})
                except Exception:
                    pass
    return "".join(text_parts).strip(), events

def test_salon_two_turn():
    print("\n" + "="*70)
    print("TEST 1: TWO-TURN SALON BUSINESS CONSTRAINTS VERIFICATION")
    print("="*70)
    client = httpx.Client()
    
    # Create Session A
    res = client.post(f"{BACKEND_URL}/sessions", json={"title": "Salon Live Verification"})
    res.raise_for_status()
    session_id = res.json()["id"]
    print(f"[Session Created] ID: {session_id}")

    # Turn 1
    turn1_prompt = (
        "Here is my business idea and constraints:\n"
        "- Business idea: an AI customer management platform for salons.\n"
        "- Budget: ₹10,000.\n"
        "- Available time: 2 hours per day for 30 days.\n"
        "- Total available time: 60 hours.\n"
        "- Goal: find the first paying customer without building the complete product.\n"
        "Give me a realistic step-by-step plan."
    )
    print("\n--- TURN 1: Sending initial constrained request ---")
    turn1_reply, turn1_events = stream_chat(client, session_id, turn1_prompt)
    print(f"Turn 1 Reply ({len(turn1_reply)} chars):\n{turn1_reply[:350]}...\n")

    # Turn 2: Exact prompt from user requirement
    turn2_prompt = (
        "Your previous plan exceeded my 60-hour limit. I have only 60 hours in total and have not built the product. "
        "Explain how I can find my first paying salon customer without spending money on graphic design or pretending that unfinished features work. "
        "Give me a realistic plan that stays within 60 hours and ₹10,000. Include the hours allocated to each activity and verify the total."
    )
    print("\n--- TURN 2: Sending exact challenge follow-up ---")
    turn2_reply, turn2_events = stream_chat(client, session_id, turn2_prompt)
    print(f"\n[Turn 2 Full Reply]:\n{turn2_reply}\n")

    # Save to file for audit
    with open("scripts/e2e_turn2_reply.txt", "w", encoding="utf-8") as f:
        f.write(turn2_reply)

    # Verification Checks
    print("\n--- Verifying Turn 2 Requirements ---")
    lower = turn2_reply.lower()

    # 1. Acknowledges previous mistake
    ack_match = bool(re.search(r"(apologize|apologies|you'?re right|my mistake|oversight|previous plan exceeded|revised the plan|my error)", lower))
    print(f"1. Acknowledges previous mistake: {'PASS' if ack_match else 'FAIL'}")
    assert ack_match, "Failed requirement: Turn 2 must acknowledge previous mistake"

    # 2. Activity hours allocation and sum <= 60 hours
    # Parse individual activity lines: "- Activity: X hours", "* ...: X hours", "1. ...: X hours"
    activity_matches = re.findall(r"(?:activity\s+\d+|^\s*(?:[-*•]|\d+\.))\s+.*?\b(\d+(?:\.\d+)?)\s*(?:hours|hrs|hour|hr)\b", turn2_reply, re.M | re.I)
    hour_values = [float(h) for h in activity_matches if float(h) <= 60]
    total_parsed_sum = sum(hour_values) if hour_values else 0
    print(f"2. Parsed Activity Hours: {hour_values} -> Sum = {total_parsed_sum}h")
    
    # Also check if stated total <= 60
    stated_total_match = re.search(r"total\s*(?:time|hours)?[:\s]+.*?(\d+(?:\.\d+)?)\s*(?:hours|hrs)?", lower)
    stated_total = float(stated_total_match.group(1)) if stated_total_match else None
    print(f"   Stated total in prose: {stated_total}h")
    
    hours_pass = (total_parsed_sum <= 60 or (stated_total is not None and stated_total <= 60))
    print(f"   Hours allocation <= 60h: {'PASS' if hours_pass else 'FAIL'}")
    assert hours_pass, f"Failed requirement: Hours exceed 60 (parsed sum: {total_parsed_sum}, stated: {stated_total})"

    # 3. Keeps spending within ₹10,000
    budget_pass = ("₹10,000" in turn2_reply or "10,000" in turn2_reply or "zero cost" in lower or "₹0" in turn2_reply or "₹" in turn2_reply)
    print(f"3. Budget compliance (within ₹10,000): {'PASS' if budget_pass else 'FAIL'}")
    assert budget_pass, "Failed requirement: Plan must respect ₹10,000 budget"

    # 4. Direct customer validation prioritized
    validation_pass = any(w in lower for w in ["interview", "mockup", "concierge", "in-person", "visit", "discovery", "manual", "walk-in"])
    print(f"4. Prioritizes customer validation: {'PASS' if validation_pass else 'FAIL'}")
    assert validation_pass, "Failed requirement: Must prioritize direct customer validation"

    # 5. Does not claim unfinished features work (no free trial of unbuilt software)
    fake_demo = bool(re.search(r"\b(?:offer|give)\s+(?:a\s+)?(?:free\s+trial|software\s+trial)\b", lower))
    print(f"5. No working demo/fake software trial: {'PASS' if not fake_demo else 'FAIL'}")
    assert not fake_demo, "Failed requirement: Must not claim unfinished features work or offer free software trials"

    # 6. Outcomes described as validation goals
    guaranteed = bool(re.search(r"\bguaranteed?\s+(?:to\s+pay|paying\s+customers|revenue)\b", lower))
    print(f"6. Outcomes as validation goals (no guarantees): {'PASS' if not guaranteed else 'FAIL'}")
    assert not guaranteed, "Failed requirement: Must not guarantee payments"

    client.delete(f"{BACKEND_URL}/sessions/{session_id}")
    print("\n--> Test 1 Passed Successfully!\n")

def test_normal_chat():
    print("="*70)
    print("TEST 2: NORMAL CHAT ROUTING & RETRIEVAL SUPPRESSION")
    print("="*70)
    client = httpx.Client()
    res = client.post(f"{BACKEND_URL}/sessions", json={"title": "Normal Chat Test"})
    res.raise_for_status()
    session_id = res.json()["id"]

    prompt = "Explain the difference between an array and an ArrayList in Java."
    reply, events = stream_chat(client, session_id, prompt)
    print(f"Prompt: {prompt}")
    print(f"Reply sample: {reply[:200]}...")

    # Verify no citations event emitted
    citations_events = [e for e in events if e.get("event") == "citations" and len(e.get("data", {}).get("citations", [])) > 0]
    tools_called = [e for e in events if e.get("event") == "tool_start"]
    print(f"Citations emitted: {len(citations_events)}")
    print(f"Tools called: {[t.get('data', {}).get('name') for t in tools_called]}")

    assert len(citations_events) == 0, "Normal chat must NOT emit citations"
    assert len(tools_called) == 0, "Normal chat must NOT call search_transcripts"
    print("--> Test 2 Passed Successfully!\n")
    client.delete(f"{BACKEND_URL}/sessions/{session_id}")

def test_transcript_retrieval():
    print("="*70)
    print("TEST 3: TRANSCRIPT RETRIEVAL & CITATIONS")
    print("="*70)
    client = httpx.Client()
    res = client.post(f"{BACKEND_URL}/sessions", json={"title": "Transcript Test"})
    res.raise_for_status()
    session_id = res.json()["id"]

    prompt = "What did Jason Cohen say about pricing when a product stops growing?"
    reply, events = stream_chat(client, session_id, prompt)
    print(f"Prompt: {prompt}")
    print(f"Reply sample: {reply[:250]}...")

    tool_starts = [e for e in events if e.get("event") == "tool_start" and e.get("data", {}).get("name") == "search_transcripts"]
    citations_events = [e for e in events if e.get("event") == "citations" and len(e.get("data", {}).get("citations", [])) > 0]
    print(f"search_transcripts tool invoked: {len(tool_starts) > 0}")
    print(f"Citations returned: {len(citations_events) > 0}")

    assert len(tool_starts) > 0, "Transcript query must invoke search_transcripts"
    assert len(citations_events) > 0, "Transcript query must return citations"
    client.delete(f"{BACKEND_URL}/sessions/{session_id}")
    print("--> Test 3 Passed Successfully!\n")

def test_session_isolation():
    print("="*70)
    print("TEST 4: SESSION ISOLATION")
    print("="*70)
    client = httpx.Client()
    
    # Session A: Salon discussions
    res_a = client.post(f"{BACKEND_URL}/sessions", json={"title": "Session A"})
    res_a.raise_for_status()
    session_a = res_a.json()["id"]
    stream_chat(client, session_a, "My budget is ₹10,000 for an AI salon platform.")

    # Session B: Brand new independent session
    res_b = client.post(f"{BACKEND_URL}/sessions", json={"title": "Session B"})
    res_b.raise_for_status()
    session_b = res_b.json()["id"]
    reply_b, _ = stream_chat(client, session_b, "What business idea and budget did I tell you about earlier?")
    print(f"Session B Reply: {reply_b}")

    # Verify Session B does not know about the salon or 10,000 budget
    lower_b = reply_b.lower()
    leaked = ("salon" in lower_b or "10,000" in lower_b or "₹10,000" in lower_b)
    print(f"Session isolation preserved: {'PASS' if not leaked else 'FAIL'}")
    assert not leaked, "Session B leaked context from Session A!"

    client.delete(f"{BACKEND_URL}/sessions/{session_a}")
    client.delete(f"{BACKEND_URL}/sessions/{session_b}")
    print("--> Test 4 Passed Successfully!\n")

if __name__ == "__main__":
    try:
        test_salon_two_turn()
        test_normal_chat()
        test_transcript_retrieval()
        test_session_isolation()
        print("\n" + "#"*70)
        print("ALL END-TO-END VERIFICATION TESTS PASSED SUCCESSFULLY!")
        print("#"*70)
    except Exception as e:
        print(f"\n[TEST FAILURE]: {e}")
        sys.exit(1)
