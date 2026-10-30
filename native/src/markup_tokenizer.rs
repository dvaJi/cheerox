//! A port of htmlparser2's Tokenizer state machine over UTF-16 code units.
//!
//! Offsets are UTF-16 indices, as in htmlparser2. Text and attribute values are
//! reported as raw spans; the tree builder decodes them, which yields the same
//! text as htmlparser2's per-entity callbacks because adjacent text merges.

const TAB: u16 = 0x09;
const NEW_LINE: u16 = 0x0a;
const FORM_FEED: u16 = 0x0c;
const CARRIAGE_RETURN: u16 = 0x0d;
const SPACE: u16 = 0x20;
const EXCLAMATION_MARK: u16 = 0x21;
const DOUBLE_QUOTE: u16 = 0x22;
const AMP: u16 = 0x26;
const SINGLE_QUOTE: u16 = 0x27;
const DASH: u16 = 0x2d;
const SLASH: u16 = 0x2f;
const LT: u16 = 0x3c;
const EQ: u16 = 0x3d;
const GT: u16 = 0x3e;
const QUESTION_MARK: u16 = 0x3f;
const OPENING_SQUARE_BRACKET: u16 = 0x5b;

const CDATA: &[u8] = b"CDATA[";
const CDATA_END: &[u8] = b"]]>";
const COMMENT_END: &[u8] = b"-->";
const SCRIPT_END: &[u8] = b"</script";
const STYLE_END: &[u8] = b"</style";
const TITLE_END: &[u8] = b"</title";
const TEXTAREA_END: &[u8] = b"</textarea";
const XMP_END: &[u8] = b"</xmp";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Token {
    /// Raw text between `start` and `end`; `decode` marks entity decoding.
    Text {
        start: usize,
        end: usize,
        decode: bool,
    },
    OpenTagName {
        start: usize,
        end: usize,
    },
    OpenTagEnd {
        end: usize,
    },
    SelfClosingTag {
        end: usize,
    },
    AttributeName {
        start: usize,
        end: usize,
    },
    /// Raw attribute value data; `decode` marks entity decoding.
    AttributeData {
        start: usize,
        end: usize,
        decode: bool,
    },
    AttributeEnd {
        end: usize,
    },
    CloseTag {
        start: usize,
        end: usize,
    },
    Comment {
        start: usize,
        end: usize,
        end_offset: usize,
    },
    Cdata {
        start: usize,
        end: usize,
        end_offset: usize,
    },
    Declaration {
        start: usize,
        end: usize,
    },
    ProcessingInstruction {
        start: usize,
        end: usize,
    },
    End,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Text,
    BeforeTagName,
    InTagName,
    InSelfClosingTag,
    BeforeClosingTagName,
    InClosingTagName,
    AfterClosingTagName,
    BeforeAttributeName,
    InAttributeName,
    AfterAttributeName,
    BeforeAttributeValue,
    InAttributeValueDq,
    InAttributeValueSq,
    InAttributeValueNq,
    BeforeDeclaration,
    InDeclaration,
    InProcessingInstruction,
    BeforeComment,
    CdataSequence,
    InSpecialComment,
    InCommentLike,
    BeforeSpecialS,
    BeforeSpecialT,
    SpecialStartSequence,
    InSpecialTag,
}

fn is_whitespace(c: u16) -> bool {
    matches!(c, SPACE | NEW_LINE | TAB | FORM_FEED | CARRIAGE_RETURN)
}

fn is_end_of_tag_section(c: u16) -> bool {
    c == SLASH || c == GT || is_whitespace(c)
}

fn is_ascii_alpha(c: u16) -> bool {
    (u16::from(b'a')..=u16::from(b'z')).contains(&c)
        || (u16::from(b'A')..=u16::from(b'Z')).contains(&c)
}

fn lower(c: u16) -> u16 {
    c | 0x20
}

/// Tokenizes `units` and passes each token to `emit`, in htmlparser2's order.
pub(crate) fn tokenize(units: &[u16], xml: bool, decode: bool, emit: impl FnMut(Token)) {
    let mut tokenizer = Tokenizer {
        units,
        xml,
        decode,
        emit,
        state: State::Text,
        section_start: Some(0),
        index: 0,
        is_special: false,
        sequence: COMMENT_END,
        sequence_index: 0,
    };
    tokenizer.run();
}

struct Tokenizer<'a, F: FnMut(Token)> {
    units: &'a [u16],
    xml: bool,
    decode: bool,
    emit: F,
    state: State,
    /// Start of the section being read; `None` matches htmlparser2's `-1`.
    section_start: Option<usize>,
    index: usize,
    is_special: bool,
    sequence: &'static [u8],
    sequence_index: usize,
}

impl<F: FnMut(Token)> Tokenizer<'_, F> {
    fn run(&mut self) {
        while self.index < self.units.len() {
            let c = self.units[self.index];
            match self.state {
                State::Text => self.state_text(c),
                State::SpecialStartSequence => self.state_special_start_sequence(c),
                State::InSpecialTag => self.state_in_special_tag(c),
                State::CdataSequence => self.state_cdata_sequence(c),
                State::InAttributeValueDq => self.state_in_attribute_value_quoted(c, DOUBLE_QUOTE),
                State::InAttributeName => self.state_in_attribute_name(c),
                State::InCommentLike => self.state_in_comment_like(c),
                State::InSpecialComment => self.state_in_special_comment(c),
                State::BeforeAttributeName => self.state_before_attribute_name(c),
                State::InTagName => self.state_in_tag_name(c),
                State::InClosingTagName => self.state_in_closing_tag_name(c),
                State::BeforeTagName => self.state_before_tag_name(c),
                State::AfterAttributeName => self.state_after_attribute_name(c),
                State::InAttributeValueSq => self.state_in_attribute_value_quoted(c, SINGLE_QUOTE),
                State::BeforeAttributeValue => self.state_before_attribute_value(c),
                State::BeforeClosingTagName => self.state_before_closing_tag_name(c),
                State::AfterClosingTagName => self.state_after_closing_tag_name(c),
                State::BeforeSpecialS => self.state_before_special_s(c),
                State::BeforeSpecialT => self.state_before_special_t(c),
                State::InAttributeValueNq => self.state_in_attribute_value_unquoted(c),
                State::InSelfClosingTag => self.state_in_self_closing_tag(c),
                State::InDeclaration => self.state_in_declaration(c),
                State::BeforeDeclaration => self.state_before_declaration(c),
                State::BeforeComment => self.state_before_comment(c),
                State::InProcessingInstruction => self.state_in_processing_instruction(c),
            }
            self.index += 1;
        }
        self.finish();
    }

    fn start(&self) -> usize {
        self.section_start.unwrap_or(0)
    }

    fn emit_text(&mut self, start: usize, end: usize, decode: bool) {
        if start < end {
            (self.emit)(Token::Text { start, end, decode });
        }
    }

    /// Advances to the next `c`; leaves `index` on the last unit when absent.
    fn fast_forward_to(&mut self, c: u16) -> bool {
        while self.index + 1 < self.units.len() {
            self.index += 1;
            if self.units[self.index] == c {
                return true;
            }
        }
        self.index = self.units.len().saturating_sub(1);
        false
    }

    // Entities are decoded per span, so `&` never changes state and text can
    // skip ahead to the next `<` whether or not entities are decoded.
    fn state_text(&mut self, c: u16) {
        if c == LT || self.fast_forward_to(LT) {
            let start = self.start();
            if self.index > start {
                self.emit_text(start, self.index, self.decode);
            }
            self.state = State::BeforeTagName;
            self.section_start = Some(self.index);
        }
    }

    fn state_special_start_sequence(&mut self, c: u16) {
        let is_end = self.sequence_index == self.sequence.len();
        let is_match = if is_end {
            is_end_of_tag_section(c)
        } else {
            lower(c) == u16::from(self.sequence[self.sequence_index])
        };
        if !is_match {
            self.is_special = false;
        } else if !is_end {
            self.sequence_index += 1;
            return;
        }
        self.sequence_index = 0;
        self.state = State::InTagName;
        self.state_in_tag_name(c);
    }

    fn state_in_special_tag(&mut self, c: u16) {
        if self.sequence_index == self.sequence.len() {
            if c == GT || is_whitespace(c) {
                let end_of_text = self.index - self.sequence.len();
                let start = self.start();
                if start < end_of_text {
                    let is_title = self.sequence == TITLE_END;
                    self.emit_text(start, end_of_text, is_title && self.decode);
                }
                self.is_special = false;
                self.section_start = Some(end_of_text + 2);
                self.state_in_closing_tag_name(c);
                return;
            }
            self.sequence_index = 0;
        }
        let is_title = self.sequence == TITLE_END;
        if lower(c) == u16::from(self.sequence[self.sequence_index]) {
            self.sequence_index += 1;
        } else if self.sequence_index == 0 {
            // htmlparser2 examines every unit of a title to decode entities.
            if !is_title && self.fast_forward_to(LT) {
                self.sequence_index = 1;
            }
        } else {
            if is_title && self.decode && c == AMP {
                // After a partial `</title` match, htmlparser2 consumes `&`
                // without starting an entity, so it stays undecoded.
                let start = self.start();
                self.emit_text(start, self.index, true);
                self.emit_text(self.index, self.index + 1, false);
                self.section_start = Some(self.index + 1);
            }
            self.sequence_index = usize::from(c == LT);
        }
    }

    fn state_cdata_sequence(&mut self, c: u16) {
        if c == u16::from(CDATA[self.sequence_index]) {
            self.sequence_index += 1;
            if self.sequence_index == CDATA.len() {
                self.state = State::InCommentLike;
                self.sequence = CDATA_END;
                self.sequence_index = 0;
                self.section_start = Some(self.index + 1);
            }
        } else {
            self.sequence_index = 0;
            self.state = State::InDeclaration;
            self.state_in_declaration(c);
        }
    }

    fn state_in_comment_like(&mut self, c: u16) {
        if c == u16::from(self.sequence[self.sequence_index]) {
            self.sequence_index += 1;
            if self.sequence_index == self.sequence.len() {
                let start = self.start();
                let token = if self.sequence == CDATA_END {
                    Token::Cdata {
                        start,
                        end: self.index,
                        end_offset: 2,
                    }
                } else {
                    Token::Comment {
                        start,
                        end: self.index,
                        end_offset: 2,
                    }
                };
                (self.emit)(token);
                self.sequence_index = 0;
                self.section_start = Some(self.index + 1);
                self.state = State::Text;
            }
        } else if self.sequence_index == 0 {
            if self.fast_forward_to(u16::from(self.sequence[0])) {
                self.sequence_index = 1;
            }
        } else if c != u16::from(self.sequence[self.sequence_index - 1]) {
            self.sequence_index = 0;
        }
    }

    /// HTML tag names start with an ASCII letter; XML allows anything that
    /// does not end the tag section.
    fn is_tag_start_char(&self, c: u16) -> bool {
        if self.xml {
            !is_end_of_tag_section(c)
        } else {
            is_ascii_alpha(c)
        }
    }

    fn start_special(&mut self, sequence: &'static [u8], offset: usize) {
        self.is_special = true;
        self.sequence = sequence;
        self.sequence_index = offset;
        self.state = State::SpecialStartSequence;
    }

    fn state_before_tag_name(&mut self, c: u16) {
        if c == EXCLAMATION_MARK {
            self.state = State::BeforeDeclaration;
            self.section_start = Some(self.index + 1);
        } else if c == QUESTION_MARK {
            self.state = State::InProcessingInstruction;
            self.section_start = Some(self.index + 1);
        } else if self.is_tag_start_char(c) {
            let lowered = lower(c);
            self.section_start = Some(self.index);
            self.state = if self.xml {
                State::InTagName
            } else if lowered == u16::from(SCRIPT_END[2]) {
                State::BeforeSpecialS
            } else if lowered == u16::from(TITLE_END[2]) || lowered == u16::from(XMP_END[2]) {
                State::BeforeSpecialT
            } else {
                State::InTagName
            };
        } else if c == SLASH {
            self.state = State::BeforeClosingTagName;
        } else {
            self.state = State::Text;
            self.state_text(c);
        }
    }

    fn state_in_tag_name(&mut self, c: u16) {
        if is_end_of_tag_section(c) {
            let start = self.start();
            (self.emit)(Token::OpenTagName {
                start,
                end: self.index,
            });
            self.section_start = None;
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        }
    }

    fn state_before_closing_tag_name(&mut self, c: u16) {
        if c == GT {
            self.state = State::Text;
        } else if !is_whitespace(c) {
            self.state = if self.is_tag_start_char(c) {
                State::InClosingTagName
            } else {
                State::InSpecialComment
            };
            self.section_start = Some(self.index);
        }
    }

    fn state_in_closing_tag_name(&mut self, c: u16) {
        if c == GT || is_whitespace(c) {
            let start = self.start();
            (self.emit)(Token::CloseTag {
                start,
                end: self.index,
            });
            self.section_start = None;
            self.state = State::AfterClosingTagName;
            self.state_after_closing_tag_name(c);
        }
    }

    fn state_after_closing_tag_name(&mut self, c: u16) {
        if c == GT || self.fast_forward_to(GT) {
            self.state = State::Text;
            self.section_start = Some(self.index + 1);
        }
    }

    fn state_before_attribute_name(&mut self, c: u16) {
        if c == GT {
            (self.emit)(Token::OpenTagEnd { end: self.index });
            if self.is_special {
                self.state = State::InSpecialTag;
                self.sequence_index = 0;
            } else {
                self.state = State::Text;
            }
            self.section_start = Some(self.index + 1);
        } else if c == SLASH {
            self.state = State::InSelfClosingTag;
        } else if !is_whitespace(c) {
            self.state = State::InAttributeName;
            self.section_start = Some(self.index);
        }
    }

    fn state_in_self_closing_tag(&mut self, c: u16) {
        if c == GT {
            (self.emit)(Token::SelfClosingTag { end: self.index });
            self.state = State::Text;
            self.section_start = Some(self.index + 1);
            self.is_special = false;
        } else if !is_whitespace(c) {
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        }
    }

    fn state_in_attribute_name(&mut self, c: u16) {
        if c == EQ || is_end_of_tag_section(c) {
            let start = self.start();
            (self.emit)(Token::AttributeName {
                start,
                end: self.index,
            });
            self.section_start = Some(self.index);
            self.state = State::AfterAttributeName;
            self.state_after_attribute_name(c);
        }
    }

    fn state_after_attribute_name(&mut self, c: u16) {
        if c == EQ {
            self.state = State::BeforeAttributeValue;
        } else if c == SLASH || c == GT {
            let end = self.start();
            (self.emit)(Token::AttributeEnd { end });
            self.section_start = None;
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        } else if !is_whitespace(c) {
            let end = self.start();
            (self.emit)(Token::AttributeEnd { end });
            self.state = State::InAttributeName;
            self.section_start = Some(self.index);
        }
    }

    fn state_before_attribute_value(&mut self, c: u16) {
        if c == DOUBLE_QUOTE {
            self.state = State::InAttributeValueDq;
            self.section_start = Some(self.index + 1);
        } else if c == SINGLE_QUOTE {
            self.state = State::InAttributeValueSq;
            self.section_start = Some(self.index + 1);
        } else if !is_whitespace(c) {
            self.section_start = Some(self.index);
            self.state = State::InAttributeValueNq;
            self.state_in_attribute_value_unquoted(c);
        }
    }

    fn state_in_attribute_value_quoted(&mut self, c: u16, quote: u16) {
        if c == quote || self.fast_forward_to(quote) {
            let start = self.start();
            (self.emit)(Token::AttributeData {
                start,
                end: self.index,
                decode: self.decode,
            });
            self.section_start = None;
            (self.emit)(Token::AttributeEnd {
                end: self.index + 1,
            });
            self.state = State::BeforeAttributeName;
        }
    }

    fn state_in_attribute_value_unquoted(&mut self, c: u16) {
        if is_whitespace(c) || c == GT {
            let start = self.start();
            (self.emit)(Token::AttributeData {
                start,
                end: self.index,
                decode: self.decode,
            });
            self.section_start = None;
            (self.emit)(Token::AttributeEnd { end: self.index });
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        }
    }

    fn state_before_declaration(&mut self, c: u16) {
        if c == OPENING_SQUARE_BRACKET {
            self.state = State::CdataSequence;
            self.sequence_index = 0;
        } else {
            self.state = if c == DASH {
                State::BeforeComment
            } else {
                State::InDeclaration
            };
        }
    }

    fn state_in_declaration(&mut self, c: u16) {
        if c == GT || self.fast_forward_to(GT) {
            let start = self.start();
            (self.emit)(Token::Declaration {
                start,
                end: self.index,
            });
            self.state = State::Text;
            self.section_start = Some(self.index + 1);
        }
    }

    fn state_in_processing_instruction(&mut self, c: u16) {
        if c == GT || self.fast_forward_to(GT) {
            let start = self.start();
            (self.emit)(Token::ProcessingInstruction {
                start,
                end: self.index,
            });
            self.state = State::Text;
            self.section_start = Some(self.index + 1);
        }
    }

    fn state_before_comment(&mut self, c: u16) {
        if c == DASH {
            self.state = State::InCommentLike;
            self.sequence = COMMENT_END;
            // A comment may close immediately, as in `<!-->`.
            self.sequence_index = 2;
            self.section_start = Some(self.index + 1);
        } else {
            self.state = State::InDeclaration;
        }
    }

    fn state_in_special_comment(&mut self, c: u16) {
        if c == GT || self.fast_forward_to(GT) {
            let start = self.start();
            (self.emit)(Token::Comment {
                start,
                end: self.index,
                end_offset: 0,
            });
            self.state = State::Text;
            self.section_start = Some(self.index + 1);
        }
    }

    fn state_before_special_s(&mut self, c: u16) {
        let lowered = lower(c);
        if lowered == u16::from(SCRIPT_END[3]) {
            self.start_special(SCRIPT_END, 4);
        } else if lowered == u16::from(STYLE_END[3]) {
            self.start_special(STYLE_END, 4);
        } else {
            self.state = State::InTagName;
            self.state_in_tag_name(c);
        }
    }

    fn state_before_special_t(&mut self, c: u16) {
        let lowered = lower(c);
        if lowered == u16::from(TITLE_END[3]) {
            self.start_special(TITLE_END, 4);
        } else if lowered == u16::from(TEXTAREA_END[3]) {
            self.start_special(TEXTAREA_END, 4);
        } else if lowered == u16::from(XMP_END[3]) {
            self.start_special(XMP_END, 4);
        } else {
            self.state = State::InTagName;
            self.state_in_tag_name(c);
        }
    }

    /// Mirrors htmlparser2's end-of-buffer cleanup followed by `finish`.
    fn finish(&mut self) {
        let end = self.units.len();
        let start = self.start();
        match self.state {
            State::Text => self.emit_text(start, end, self.decode),
            State::InSpecialTag => {
                let decode = self.sequence == TITLE_END && self.decode;
                self.emit_text(start, end, decode);
            }
            State::InAttributeValueDq | State::InAttributeValueSq | State::InAttributeValueNq => {
                // An unfinished tag is dropped, as htmlparser2 does.
            }
            State::InCommentLike if start < end => {
                let token = if self.sequence == CDATA_END {
                    Token::Cdata {
                        start,
                        end,
                        end_offset: 0,
                    }
                } else {
                    Token::Comment {
                        start,
                        end,
                        end_offset: 0,
                    }
                };
                (self.emit)(token);
            }
            State::InTagName
            | State::BeforeAttributeName
            | State::BeforeAttributeValue
            | State::AfterAttributeName
            | State::InAttributeName
            | State::InClosingTagName => {}
            // Other states report their remaining input as undecoded text. An
            // unset section start is -1 in htmlparser2, whose `slice(-1)` keeps
            // only the final unit.
            _ => {
                let start = self.section_start.unwrap_or(end.saturating_sub(1));
                self.emit_text(start, end, false);
            }
        }
        (self.emit)(Token::End);
    }
}
