"""Generates fictional .docx fixtures used by the browser tests (no real case data)."""
import sys
from docx import Document

def build(path, round2=False):
    d = Document()
    d.add_paragraph("FICTIONAL TEST v. NOBODY INC.")
    d.add_paragraph("RESPONSES TO FIRST SET OF REQUESTS FOR PRODUCTION")
    d.add_paragraph("Responding Party objects to the Requests as set forth in Fed. R. Civ. P. 34(b)(2)(C). These General Objections apply to every response.")
    d.add_paragraph("REQUEST FOR PRODUCTION NO. 1:")
    d.add_paragraph("All DOCUMENTS RELATING TO the widget contract.")
    d.add_paragraph("RESPONSE TO REQUEST FOR PRODUCTION NO. 1:")
    d.add_paragraph("Responding Party objects to this Request as vague. See Smith v. Jones, 123 F.3d 456 (9th Cir. 2001).")
    if round2:
        d.add_paragraph("Responding Party will produce responsive, non-privileged documents within 21 days.")
    else:
        d.add_paragraph("Responding Party will produce responsive documents.")
    d.add_paragraph("REQUEST FOR PRODUCTION NO. 2: All invoices sent to YOU by Nobody Inc.")
    d.add_paragraph("RESPONSE TO REQUEST FOR PRODUCTION NO. 2: Responding Party will produce the invoices. Production will be made on a rolling basis.")
    # A table paragraph (tables must also be read)
    t = d.add_table(rows=1, cols=1)
    t.cell(0, 0).text = "The invoices are identified in Exhibit A."
    d.add_paragraph("REQUEST FOR PRODUCTION NO. 3:")
    d.add_paragraph("All DOCUMENTS concerning the meeting held on May 1, 2025.")
    d.add_paragraph("RESPONSE TO REQUEST FOR PRODUCTION NO. 3:")
    d.add_paragraph("Responding Party has no responsive documents.")
    d.add_paragraph("Dated: January 2, 2026")
    d.add_paragraph("/s/ Test Attorney")
    d.save(path)

build(sys.argv[1] + "/fictional_round1.docx")
build(sys.argv[1] + "/fictional_round2.docx", round2=True)
