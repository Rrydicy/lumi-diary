import csv
import io
import json
import os
import sqlite3
import sys
from datetime import datetime
from functools import wraps
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SQLITE_DB_PATH", str(BASE_DIR / "lumi_diary.db")))
STATIC_DIR = BASE_DIR / "static"
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
IS_POSTGRES = bool(DATABASE_URL)

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config["JSON_AS_ASCII"] = False


# ==============================================================================
# Unified Database Wrapper (Supports Cloud PostgreSQL + Local SQLite)
# ==============================================================================
class DBWrapper:
    def __init__(self, conn, is_postgres: bool):
        self.conn = conn
        self.is_postgres = is_postgres

    def _sql(self, query: str) -> str:
        if self.is_postgres:
            return query.replace("?", "%s")
        return query

    def execute(self, query: str, params=()):
        cur = self.conn.cursor()
        cur.execute(self._sql(query), params)
        return cur

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()


def get_db() -> DBWrapper:
    if IS_POSTGRES:
        import psycopg
        from psycopg.rows import dict_row

        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        return DBWrapper(conn, True)
    else:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        return DBWrapper(conn, False)


def init_db():
    db = get_db()
    pk_type = "SERIAL PRIMARY KEY" if db.is_postgres else "INTEGER PRIMARY KEY AUTOINCREMENT"

    # Participants table
    db.execute(
        f"""
        CREATE TABLE IF NOT EXISTS participants (
            id {pk_type},
            participant_code TEXT UNIQUE NOT NULL,
            name TEXT UNIQUE NOT NULL,
            ai_style_preset TEXT DEFAULT '',
            ai_style_custom TEXT DEFAULT '',
            onboarding_completed INTEGER DEFAULT 0,
            consent_agreed INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    # Diary entries table
    db.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diary_entries (
            id {pk_type},
            participant_id INTEGER NOT NULL,
            diary_date TEXT NOT NULL,
            current_step INTEGER DEFAULT 1,
            mood_before INTEGER,
            q1_affirmation TEXT DEFAULT '',
            q2_gratitude_1 TEXT DEFAULT '',
            q3_gratitude_2 TEXT DEFAULT '',
            q4_gratitude_self TEXT DEFAULT '',
            q5_reflection TEXT DEFAULT '',
            mood_after INTEGER,
            lumi_feedback TEXT DEFAULT '',
            ai_style_snapshot TEXT DEFAULT '',
            status TEXT DEFAULT 'in_progress',
            star_lit INTEGER DEFAULT 0,
            started_at TEXT,
            completed_at TEXT,
            updated_at TEXT,
            UNIQUE(participant_id, diary_date),
            FOREIGN KEY(participant_id) REFERENCES participants(id)
        )
        """
    )

    # System settings table (stores admin password, Gemini API key if set via UI)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )

    # Ensure default admin password setting exists
    db.execute(
        "INSERT INTO system_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO NOTHING",
        ("admin_password", os.environ.get("ADMIN_PASSWORD", "lumi2026")),
    )

    db.commit()
    db.close()


init_db()


def get_setting(key: str, default: str = "") -> str:
    db = get_db()
    row = db.execute(
        "SELECT value FROM system_settings WHERE key = ?", (key,)
    ).fetchone()
    db.close()
    if row and row["value"]:
        return row["value"]
    return default


def set_setting(key: str, value: str):
    db = get_db()
    db.execute(
        "INSERT INTO system_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    db.commit()
    db.close()


def get_active_gemini_api_key() -> str:
    db_key = get_setting("gemini_api_key", "").strip()
    if db_key:
        return db_key
    return os.environ.get("GEMINI_API_KEY", "").strip()


# ==============================================================================
# Lumi AI Feedback Generator (Gemini API + Strict Persona Rules)
# ==============================================================================
STYLE_DESCRIPTIONS = {
    "🌷 溫柔陪伴": "語氣溫柔、輕柔、安定，像溫暖的微光靜靜陪伴在身邊，給予柔和的接納。",
    "✨ 活潑自然": "語氣輕快、有朝氣、自然真誠，帶著溫暖的微笑感，但不過度誇張或強迫正向。",
    "🌿 簡短直接": "語氣乾淨、簡潔、不囉嗦，直接點出使用者今天記錄下的重點與努力，溫暖而俐落。",
    "💬 像朋友一樣": "語氣像熟識多年的貼心好友，自然親切、平易近人，用日常對話的方式回應。",
}


def build_lumi_system_instruction(style_preset: str, style_custom: str) -> str:
    style_desc = STYLE_DESCRIPTIONS.get(
        style_preset, "語氣溫暖、柔和、自然陪伴。"
    )
    custom_clause = (
        f"\n- 使用者額外指定的回應偏好：「{style_custom}」（請務必配合此偏好調整語氣）。"
        if style_custom.strip()
        else ""
    )

    return f"""你是「Lumi」，《感恩星球｜Lumi 的每日心光日記》中的溫暖陪伴精靈。
你的任務是在使用者完成整篇每日感恩日記（包含五個問題）後，提供一次簡短、個人化的整體回饋。

【使用者設定的回饋風格】
- 預設風格：{style_preset or '🌷 溫柔陪伴'}（{style_desc}）{custom_clause}

【嚴格遵守的回饋原則】
1. 必須完全根據使用者今天實際填寫的內容來回應（使用者跳過或空白的題目不要提及）。
2. 絕對不要過度延伸、不要猜測使用者的內心世界、不要進行心理分析。
3. 絕對不要加入使用者沒有提到的事情或情境。
4. 絕對不要提供未經要求的建議、指導或說教（即便使用者在第五題寫了檢討，也只要溫和接納或陪伴，不要幫他出主意或教他怎麼做）。
5. 絕對不要強迫正向思考（不要說「往好處想」、「你一定可以更棒」這類空泛口號）。
6. 回饋請保持自然、簡短，控制在 1 至 3 句話（約 40～100 字內），使用繁體中文。"""


def build_lumi_user_prompt(entry: dict) -> str:
    parts = []
    if (entry.get("q1_affirmation") or "").strip():
        parts.append(f"1. 今天肯定自己的事：{entry['q1_affirmation'].strip()}")
    if (entry.get("q2_gratitude_1") or "").strip():
        parts.append(f"2. 第一個感恩的事：{entry['q2_gratitude_1'].strip()}")
    if (entry.get("q3_gratitude_2") or "").strip():
        parts.append(f"3. 第二個感恩的事：{entry['q3_gratitude_2'].strip()}")
    if (entry.get("q4_gratitude_self") or "").strip():
        parts.append(f"4. 感謝自己的事：{entry['q4_gratitude_self'].strip()}")
    if (entry.get("q5_reflection") or "").strip():
        parts.append(f"5. 希望下次做得更好的事：{entry['q5_reflection'].strip()}")

    if not parts:
        return "使用者今天靜靜地走完了日記流程，沒有留下具體文字。"

    joined = "\n".join(parts)
    return f"以下是使用者今天在感恩日記中實際寫下的內容：\n\n{joined}\n\n請以 Lumi 的身分，根據上述實際內容與指定風格，給出 1 到 3 句簡短自然的整體回饋："


def generate_fallback_lumi_feedback(
    entry: dict, style_preset: str, style_custom: str
) -> str:
    """
    When GEMINI_API_KEY is not yet configured, produces a warm, rule-compliant
    response grounded strictly in the user's actual answers.
    """
    q1 = (entry.get("q1_affirmation") or "").strip()
    q2 = (entry.get("q2_gratitude_1") or "").strip()
    q3 = (entry.get("q3_gratitude_2") or "").strip()
    q4 = (entry.get("q4_gratitude_self") or "").strip()
    q5 = (entry.get("q5_reflection") or "").strip()

    mentions = []
    if q1:
        mentions.append(f"看見你肯定了自己「{q1}」")
    if q2 and q3:
        mentions.append(f"記下了對「{q2}」與「{q3}」的感謝")
    elif q2:
        mentions.append(f"記下了對「{q2}」的感謝")
    elif q3:
        mentions.append(f"記下了對「{q3}」的感謝")
    if q4:
        mentions.append(f"也謝謝自己「{q4}」")

    summary_text = "、".join(mentions) if mentions else "今天也花時間陪伴自己整理了日常點滴"
    reflection_note = f"，同時也誠實地記錄下關於「{q5}」的想法" if q5 else ""

    if "簡短直接" in style_preset:
        return f"今天你{summary_text}{reflection_note}。謝謝你把這些真實的日常片段記錄下來，辛苦了。"
    elif "活潑自然" in style_preset:
        return f"哇，今天你{summary_text}{reflection_note}！能把這些屬於你的日常時刻收藏起來，真的很棒呢✨"
    elif "像朋友一樣" in style_preset:
        return f"今天看你寫下{summary_text}{reflection_note}，覺得這樣的日常紀錄很真實也很珍貴。今天也辛苦你啦，好好休息喔！"
    else:
        return f"謝謝你今天溫柔地停下腳步，{summary_text}{reflection_note}。Lumi 會幫你把這份珍貴的日常心光好好收藏起來🌷"


def generate_lumi_feedback(
    entry: dict, style_preset: str, style_custom: str
) -> str:
    api_key = get_active_gemini_api_key()
    system_instruction = build_lumi_system_instruction(style_preset, style_custom)
    user_prompt = build_lumi_user_prompt(entry)

    if api_key:
        try:
            from google import genai

            client = genai.Client(api_key=api_key)
            interaction = client.interactions.create(
                model="gemini-3.8-flash",
                system_instruction=system_instruction,
                input=user_prompt,
                generation_config={"temperature": 0.65},
            )
            if interaction and interaction.output_text:
                return interaction.output_text.strip()
        except Exception as e:
            print(f"[Lumi Gemini SDK Warning] {e}")

    return generate_fallback_lumi_feedback(entry, style_preset, style_custom)


# ==============================================================================
# Participant Endpoints
# ==============================================================================
@app.route("/")
def index():
    return send_from_directory(str(STATIC_DIR), "index.html")


@app.route("/researcher-admin")
def researcher_admin_page():
    return send_from_directory(str(STATIC_DIR), "index.html")


@app.route("/api/auth/login", methods=["POST"])
def login_participant():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "請輸入你的名字或暱稱"}), 400

    db = get_db()
    row = db.execute(
        "SELECT * FROM participants WHERE name = ?", (name,)
    ).fetchone()

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if not row:
        count_row = db.execute(
            "SELECT COUNT(*) AS cnt FROM participants"
        ).fetchone()
        next_num = (count_row["cnt"] if count_row else 0) + 1
        participant_code = f"P{next_num:03d}"

        while db.execute(
            "SELECT 1 FROM participants WHERE participant_code = ?",
            (participant_code,),
        ).fetchone():
            next_num += 1
            participant_code = f"P{next_num:03d}"

        db.execute(
            """
            INSERT INTO participants (
                participant_code, name, ai_style_preset, ai_style_custom,
                onboarding_completed, consent_agreed, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)
            """,
            (participant_code, name, "🌷 溫柔陪伴", "", now_str, now_str),
        )
        db.commit()
        row = db.execute(
            "SELECT * FROM participants WHERE name = ?", (name,)
        ).fetchone()

    participant = dict(row)
    db.close()
    return jsonify({"participant": participant})


@app.route("/api/participant/<int:participant_id>", methods=["GET"])
def get_participant(participant_id: int):
    db = get_db()
    row = db.execute(
        "SELECT * FROM participants WHERE id = ?", (participant_id,)
    ).fetchone()
    db.close()
    if not row:
        return jsonify({"error": "找不到該參與者"}), 404
    return jsonify({"participant": dict(row)})


@app.route("/api/participant/<int:participant_id>/style", methods=["POST"])
def update_participant_style(participant_id: int):
    data = request.get_json(force=True) or {}
    preset = (data.get("ai_style_preset") or "").strip()
    custom = (data.get("ai_style_custom") or "").strip()

    if not preset and not custom:
        return jsonify({"error": "請選擇一種預設風格，或輸入你喜歡的回應方式"}), 400

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db = get_db()
    db.execute(
        """
        UPDATE participants
        SET ai_style_preset = ?, ai_style_custom = ?, onboarding_completed = 1, updated_at = ?
        WHERE id = ?
        """,
        (preset, custom, now_str, participant_id),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM participants WHERE id = ?", (participant_id,)
    ).fetchone()
    db.close()
    return jsonify({"participant": dict(row)})


# ==============================================================================
# Diary Endpoints
# ==============================================================================
@app.route("/api/diary/list/<int:participant_id>", methods=["GET"])
def list_diaries(participant_id: int):
    db = get_db()
    rows = db.execute(
        """
        SELECT * FROM diary_entries
        WHERE participant_id = ?
        ORDER BY diary_date DESC
        """,
        (participant_id,),
    ).fetchall()
    db.close()
    return jsonify({"entries": [dict(r) for r in rows]})


@app.route("/api/diary/<int:participant_id>/<diary_date>", methods=["GET"])
def get_diary_entry(participant_id: int, diary_date: str):
    db = get_db()
    row = db.execute(
        """
        SELECT * FROM diary_entries
        WHERE participant_id = ? AND diary_date = ?
        """,
        (participant_id, diary_date),
    ).fetchone()
    db.close()
    return jsonify({"entry": dict(row) if row else None})


@app.route("/api/diary/save", methods=["POST"])
def save_diary_step():
    data = request.get_json(force=True) or {}
    participant_id = data.get("participant_id")
    diary_date = (data.get("diary_date") or "").strip()

    if not participant_id or not diary_date:
        return jsonify({"error": "缺少參與者或日期資訊"}), 400

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db = get_db()

    p_row = db.execute(
        "SELECT * FROM participants WHERE id = ?", (participant_id,)
    ).fetchone()
    if not p_row:
        db.close()
        return jsonify({"error": "找不到參與者資料"}), 404

    existing = db.execute(
        "SELECT * FROM diary_entries WHERE participant_id = ? AND diary_date = ?",
        (participant_id, diary_date),
    ).fetchone()

    if not existing:
        db.execute(
            """
            INSERT INTO diary_entries (
                participant_id, diary_date, current_step, status, star_lit,
                started_at, updated_at
            ) VALUES (?, ?, 1, 'in_progress', 0, ?, ?)
            """,
            (participant_id, diary_date, now_str, now_str),
        )
        db.commit()
        existing = db.execute(
            "SELECT * FROM diary_entries WHERE participant_id = ? AND diary_date = ?",
            (participant_id, diary_date),
        ).fetchone()

    entry = dict(existing)

    updatable_fields = [
        "current_step",
        "mood_before",
        "q1_affirmation",
        "q2_gratitude_1",
        "q3_gratitude_2",
        "q4_gratitude_self",
        "q5_reflection",
        "mood_after",
    ]
    for field in updatable_fields:
        if field in data:
            entry[field] = data[field]

    generate_ai = bool(data.get("generate_feedback", False))
    force_regenerate = bool(data.get("force_regenerate", False))

    if (generate_ai and not (entry.get("lumi_feedback") or "").strip()) or force_regenerate:
        preset = p_row["ai_style_preset"] or "🌷 溫柔陪伴"
        custom = p_row["ai_style_custom"] or ""
        style_snapshot = preset if not custom else f"{preset}（補充：{custom}）"
        feedback_text = generate_lumi_feedback(entry, preset, custom)
        entry["lumi_feedback"] = feedback_text
        entry["ai_style_snapshot"] = style_snapshot

    if data.get("light_star"):
        entry["star_lit"] = 1
        entry["status"] = "completed"
        entry["current_step"] = 9
        if not entry.get("completed_at"):
            entry["completed_at"] = now_str

    entry["updated_at"] = now_str

    db.execute(
        """
        UPDATE diary_entries
        SET current_step = ?,
            mood_before = ?,
            q1_affirmation = ?,
            q2_gratitude_1 = ?,
            q3_gratitude_2 = ?,
            q4_gratitude_self = ?,
            q5_reflection = ?,
            mood_after = ?,
            lumi_feedback = ?,
            ai_style_snapshot = ?,
            status = ?,
            star_lit = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            entry["current_step"],
            entry["mood_before"],
            entry["q1_affirmation"],
            entry["q2_gratitude_1"],
            entry["q3_gratitude_2"],
            entry["q4_gratitude_self"],
            entry["q5_reflection"],
            entry["mood_after"],
            entry["lumi_feedback"],
            entry["ai_style_snapshot"],
            entry["status"],
            entry["star_lit"],
            entry["completed_at"],
            entry["updated_at"],
            entry["id"],
        ),
    )
    db.commit()
    updated_row = db.execute(
        "SELECT * FROM diary_entries WHERE id = ?", (entry["id"],)
    ).fetchone()
    db.close()

    return jsonify({"entry": dict(updated_row)})


# ==============================================================================
# Researcher Admin Endpoints
# ==============================================================================
def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        pwd = request.headers.get("X-Admin-Password", "") or request.args.get(
            "admin_password", ""
        )
        expected = get_setting("admin_password", "lumi2026")
        if pwd != expected:
            return jsonify({"error": "研究者密碼錯誤"}), 401
        return f(*args, **kwargs)

    return decorated


@app.route("/api/admin/overview", methods=["GET"])
@require_admin
def admin_overview():
    db = get_db()
    participants = [
        dict(r)
        for r in db.execute(
            "SELECT * FROM participants ORDER BY id ASC"
        ).fetchall()
    ]
    entries = [
        dict(r)
        for r in db.execute(
            """
            SELECT d.*, p.participant_code, p.name AS participant_name,
                   p.ai_style_preset, p.ai_style_custom
            FROM diary_entries d
            JOIN participants p ON p.id = d.participant_id
            ORDER BY d.diary_date DESC, d.updated_at DESC
            """
        ).fetchall()
    ]
    db.close()

    stats_by_pid = {}
    for p in participants:
        stats_by_pid[p["id"]] = {
            **p,
            "total_entries": 0,
            "completed_entries": 0,
            "stars_count": 0,
            "last_active_date": "-",
        }

    for e in entries:
        pid = e["participant_id"]
        if pid in stats_by_pid:
            stats_by_pid[pid]["total_entries"] += 1
            if e["status"] == "completed":
                stats_by_pid[pid]["completed_entries"] += 1
            if e["star_lit"]:
                stats_by_pid[pid]["stars_count"] += 1
            if (
                stats_by_pid[pid]["last_active_date"] == "-"
                or e["diary_date"] > stats_by_pid[pid]["last_active_date"]
            ):
                stats_by_pid[pid]["last_active_date"] = e["diary_date"]

    api_key = get_active_gemini_api_key()
    masked_key = (
        f"{api_key[:6]}...{api_key[-4:]}"
        if len(api_key) > 10
        else ("已設定" if api_key else "")
    )

    return jsonify(
        {
            "participants": list(stats_by_pid.values()),
            "entries": entries,
            "gemini_configured": bool(api_key),
            "gemini_key_masked": masked_key,
            "storage_mode": "Cloud PostgreSQL (永久保存)" if IS_POSTGRES else "SQLite",
        }
    )


@app.route("/api/admin/participant/<int:participant_id>/code", methods=["POST"])
@require_admin
def admin_update_participant_code(participant_id: int):
    data = request.get_json(force=True) or {}
    new_code = (data.get("participant_code") or "").strip()
    if not new_code:
        return jsonify({"error": "研究編號不可為空"}), 400

    db = get_db()
    dup = db.execute(
        "SELECT id FROM participants WHERE participant_code = ? AND id != ?",
        (new_code, participant_id),
    ).fetchone()
    if dup:
        db.close()
        return jsonify({"error": f"研究編號 {new_code} 已被其他參與者使用"}), 400

    db.execute(
        "UPDATE participants SET participant_code = ?, updated_at = ? WHERE id = ?",
        (new_code, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), participant_id),
    )
    db.commit()
    db.close()
    return jsonify({"ok": True, "participant_code": new_code})


@app.route("/api/admin/settings", methods=["POST"])
@require_admin
def admin_update_settings():
    data = request.get_json(force=True) or {}
    if "gemini_api_key" in data:
        set_setting("gemini_api_key", (data.get("gemini_api_key") or "").strip())
    if "new_admin_password" in data and (data.get("new_admin_password") or "").strip():
        set_setting("admin_password", data["new_admin_password"].strip())

    api_key = get_active_gemini_api_key()
    return jsonify(
        {
            "ok": True,
            "gemini_configured": bool(api_key),
            "gemini_key_masked": (
                f"{api_key[:6]}...{api_key[-4:]}" if len(api_key) > 10 else ""
            ),
        }
    )


@app.route("/api/admin/export/csv", methods=["GET"])
@require_admin
def admin_export_csv():
    db = get_db()
    rows = db.execute(
        """
        SELECT
            p.participant_code,
            p.name AS participant_name,
            p.ai_style_preset,
            p.ai_style_custom,
            d.diary_date,
            d.mood_before,
            d.q1_affirmation,
            d.q2_gratitude_1,
            d.q3_gratitude_2,
            d.q4_gratitude_self,
            d.q5_reflection,
            d.mood_after,
            d.lumi_feedback,
            d.status,
            d.star_lit,
            d.started_at,
            d.completed_at
        FROM diary_entries d
        JOIN participants p ON p.id = d.participant_id
        ORDER BY p.participant_code ASC, d.diary_date ASC
        """
    ).fetchall()
    db.close()

    output = io.StringIO()
    output.write("\ufeff")
    writer = csv.writer(output)
    writer.writerow(
        [
            "參與者研究編號",
            "參與者名稱",
            "AI回饋預設風格",
            "AI回饋自訂補充",
            "日記日期",
            "書寫前心情評分(1-5)",
            "1_一個肯定",
            "2_第一個感恩",
            "3_第二個感恩",
            "4_第三個感恩(感謝自己)",
            "5_一個檢討",
            "書寫後心情評分(1-5)",
            "Lumi整體AI回饋",
            "日記完成狀態",
            "星星點亮狀態",
            "書寫開始時間",
            "書寫完成時間",
        ]
    )

    for r in rows:
        writer.writerow(
            [
                r["participant_code"],
                r["participant_name"],
                r["ai_style_preset"],
                r["ai_style_custom"],
                r["diary_date"],
                r["mood_before"] if r["mood_before"] is not None else "",
                r["q1_affirmation"] or "",
                r["q2_gratitude_1"] or "",
                r["q3_gratitude_2"] or "",
                r["q4_gratitude_self"] or "",
                r["q5_reflection"] or "",
                r["mood_after"] if r["mood_after"] is not None else "",
                r["lumi_feedback"] or "",
                "已完成" if r["status"] == "completed" else "書寫中",
                "已點亮 ⭐" if r["star_lit"] else "未點亮",
                r["started_at"] or "",
                r["completed_at"] or "",
            ]
        )

    csv_content = output.getvalue()
    filename = f"lumi_gratitude_diary_export_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return Response(
        csv_content,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
