from app.mapping.kalshi_parser import extract_league


def test_mlb():
    assert extract_league("KXMLBGAME-26APR101420PITCHC-CHC") == "MLB"


def test_nba():
    assert extract_league("KXNBAGAME-26APR10LALORL-LAL") == "NBA"


def test_nhl():
    assert extract_league("KXNHLGAME-26MAR15BOSNYR-BOS") == "NHL"


def test_ncaab_prefers_longer_prefix():
    # KXNCAAMB should not match the shorter KXNCAAB
    assert extract_league("KXNCAAMBGAME-ABC-XYZ") == "NCAAB"
    assert extract_league("KXNCAABGAME-ABC-XYZ") == "NCAAB"
    assert extract_league("KXNCAAWBGAME-ABC-XYZ") == "NCAAW"


def test_unknown_returns_none():
    assert extract_league("KXUNKNOWN-FOO") is None
    assert extract_league("") is None
    assert extract_league("NOT-A-KALSHI-TICKER") is None


# --- Tennis prefixes ---


def test_atp_main():
    assert extract_league("KXATPMATCH-26APR12HUETOP-TOP") == "ATP"


def test_wta():
    assert extract_league("KXWTAMATCH-26APR12TIMPAQ-TIM") == "WTA"


def test_atp_challenger_beats_atp():
    # KXATPCHALLENGERMATCH is longer than KXATPMATCH — must match first.
    assert extract_league("KXATPCHALLENGERMATCH-26APR11KIMSHI-SHI") == "ATP_CHALLENGER"


def test_game_suffix_disambiguates_mlb_from_props():
    # KXMLBGAME- is game moneyline; KXMLBHRRBIS- is a player prop and should
    # not match the GAME prefix. It can still match the shorter KXMLB fallback
    # — that's fine for backend routing (the portfolio scraper filters props
    # via MONEYLINE_SERIES_RE on the extension side).
    assert extract_league("KXMLBGAME-26APR12ATHNYM-ATH") == "MLB"
    assert extract_league("KXMLBHRRBIS-foo") == "MLB"  # falls through to KXMLB
