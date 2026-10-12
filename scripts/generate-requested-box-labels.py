from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "box_labels_fbs_moscow_2026-09-23.pdf"

LABELS = [
    ("С1П6К2", "Астаксантин + Q10 + PQQ + МСТ 60 капсул"),
    ("С1П5К2", "Наттокиназа, серрапептаза, люмброкиназа, ресвератрол, Q10 убихинол, 120 капсул"),
    ("С1П4К4", "GRAFLAB Коллаген АП"),
    ("С4П4К5", "GraFLab Берберин 500 мг 60 капсул"),
    ("С3П6К1", "GraFLab Лактоферрин (lactoferrin) 60 капсул"),
    ("С4П5К2", "GraFLab Инозитол + фолиевая кислота, 1200 мг, 60 капсул"),
]

REGULAR_FONT = "BoxLabelRegular"
BOLD_FONT = "BoxLabelBold"


def register_fonts():
    font_dir = Path("C:/Windows/Fonts")
    pdfmetrics.registerFont(TTFont(REGULAR_FONT, str(font_dir / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont(BOLD_FONT, str(font_dir / "DejaVuSans-Bold.ttf")))


def text_width(text, font_name, font_size):
    return pdfmetrics.stringWidth(text, font_name, font_size)


def wrap_words(text, font_name, font_size, max_width):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if text_width(candidate, font_name, font_size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    return lines


def fit_body(text, max_width, max_height):
    for font_size in range(50, 27, -2):
        lines = wrap_words(text, REGULAR_FONT, font_size, max_width)
        leading = font_size * 1.2
        if len(lines) <= 3 and len(lines) * leading <= max_height:
            return font_size, leading, lines
    font_size = 28
    return font_size, font_size * 1.2, wrap_words(text, REGULAR_FONT, font_size, max_width)


def draw_label(canvas, code, name, slot_index):
    page_width, page_height = A4
    slot_height = page_height / 3
    slot_top = page_height - slot_index * slot_height
    slot_bottom = slot_top - slot_height

    title_size = 100
    max_title_width = page_width - 36
    while title_size > 72 and text_width(code, BOLD_FONT, title_size) > max_title_width:
        title_size -= 2

    title_top = slot_top - 37.9
    title_baseline = title_top - title_size * 0.80
    canvas.setFont(BOLD_FONT, title_size)
    canvas.drawCentredString(page_width / 2, title_baseline, code)

    body_top = slot_top - 158.1
    body_bottom = slot_bottom + 8
    body_max_height = body_top - body_bottom
    font_size, leading, lines = fit_body(name, page_width - 36, body_max_height)
    canvas.setFont(REGULAR_FONT, font_size)
    first_baseline = body_top - font_size * 0.80
    for line_index, line in enumerate(lines):
        baseline = first_baseline - line_index * leading
        canvas.drawCentredString(page_width / 2, baseline, line)

    if slot_index < 2:
        canvas.saveState()
        canvas.setStrokeColorRGB(0.74, 0.76, 0.80)
        canvas.setLineWidth(0.45)
        canvas.setDash(4, 4)
        canvas.line(22, slot_bottom, page_width - 22, slot_bottom)
        canvas.restoreState()


def main():
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(OUTPUT), pagesize=A4, pageCompression=1)
    canvas.setTitle("Наклейки на коробки - ФБС Москва")
    for index, (code, name) in enumerate(LABELS):
        draw_label(canvas, code, name, index % 3)
        if index % 3 == 2:
            canvas.showPage()
    canvas.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
