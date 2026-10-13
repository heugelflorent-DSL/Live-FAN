# Génère des pages Live FFN réduites (structure réelle relevée sur liveffn.com) pour tester les compétitions à finales.
import os
D = os.path.dirname(os.path.abspath(__file__))
def li(time, epr, typ, cat, num, label, info=""):
    return (f'<li class="survol"> <span class="presenceOk">&raquo;</span> <span class="time">{time}</span> - '
            f'<span class="tooltip" onclick=" afficheEpreuve(\'https://www.liveffn.com/cgi-bin\',\'/programme.php?\'+\'competition=90961&langue=fra\',\'&cat_id=\'+{cat}+\'&epr_id=\'+\'{epr}\'+\'&typ_id=\'+{typ}+\'&num_epreuve=\'+{num},\'containeur_ajax\',{num});" onFocus="if(this.blur)this.blur();"> '
            f'{label} <b style="width: 200px;"> {info} </b></span> </li>')
def reu(n, day, doors, items):
    return (f'<h6><a href="#">Réunion N&deg; {n} : {day}</a></h6> <div> <ul class="reunion"> <li class="debutEpreuve">Les horaires sont donnés à titre indicatif<br><br>Ouverture des portes : {doors}</li> '
            + " ".join(items) + ' <li class="EventNonSportif">Fin de la réunion</li> </ul> </div>')
def page(lieu, titre, date, body):
    return f'<html><body><div class="lieu">{lieu}</div><div class="titre">{titre}</div><div class="date">{date}</div>{body}</body></html>'
# Canet : séries le matin, finales D U15 / C U17 / B U16 / A le soir
canet = page("CANET-EN-ROUSSILLON", "6e Open d'Eté - 50 m", "Du Vendredi 17 au Mercredi 22 Juillet 2026",
  reu(1, "Vendredi 17 Juillet 2026", "07h45", [
    li("09h30", 42, 60, 0, 0, "400 4 Nages Dames Séries", "5 séries / 38 participantes <br/>"),
    li("11h09", 3, 60, 0, 4, "200 Nage Libre Dames Séries", "11 séries / 86 participantes <br/>"),
    li("11h41", 55, 62, 0, 5, "800 Nage Libre Messieurs Premières séries", "3 séries / 24 participants <br/>")]) +
  reu(2, "Vendredi 17 Juillet 2026", "15h00", [
    li("17h00", 55, 61, 0, 5, "800 Nage Libre Messieurs Série finale", "1 série / 8 participants <br/>"),
    li("17h30", 3, 14, 671781, 6, "200 Nage Libre Dames Finale D U15"),
    li("17h33", 3, 13, 653239, 7, "200 Nage Libre Dames Finale C U17"),
    li("17h37", 3, 12, 671780, 8, "200 Nage Libre Dames Finale B U16"),
    li("17h41", 3, 11, 0, 9, "200 Nage Libre Dames Finale A"),
    '<li class="EventNonSportif">Podiums U16 & TC du 200 nage libre</li>',
    li("18h19", 42, 14, 671781, 18, "400 4 Nages Dames Finale D U15"),
    li("18h26", 42, 12, 671780, 19, "400 4 Nages Dames Finale B U16"),
    li("18h33", 42, 11, 0, 20, "400 4 Nages Dames Finale A"),
    li("19h01", 34, 60, 0, 25, "4x200 Nage Libre Mixtes Séries", "2 séries / 13 participants <br/>")]))
# Épinal : libellés saisis à la main
epinal = page("ÉPINAL", "Web Confront@tion Régionale #2 - 50 m", "Du Vendredi 3 au Dimanche 5 Juillet 2026",
  reu(1, "Vendredi 3 Juillet 2026", "08h00", [li("09h00", 11, 60, 0, 0, "50 Dos Dames Séries", "9 séries / 65 participantes <br/>"),
    li("10h02", 83, 60, 0, 1, "200 Papillon Messieurs Séries", "3 séries / 21 participants <br/>")]) +
  reu(2, "Vendredi 3 Juillet 2026", "14h30", [
    li("15h30", 11, 14, 674311, 2, "50 Dos Dames 50 Dos Dames U15 et moins (Finale D)"),
    li("15h32", 11, 13, 674313, 3, "50 Dos Dames 50 Dos Dames U17 et moins (Finale C"),
    li("15h34", 11, 12, 0, 4, "50 Dos Dames 50 Dos Dames (Finale B)"),
    li("15h36", 11, 11, 0, 5, "50 Dos Dames 50 Dos Dames (Finale A)"),
    li("16h38", 83, 13, 674314, 6, "200 Papillon Messieurs 200 Papillon Messieurs U15 et moins (Finale C)"),
    li("16h42", 83, 12, 0, 7, "200 Papillon Messieurs Finale rouge"),
    li("16h46", 83, 11, 0, 8, "200 Papillon Messieurs 200 Papillon Messieurs (Finale A)")]))
# Angers : finales A par âge
angers = page("ANGERS", "5es Championnats de France Juniors 25m - 25 m", "Du Mercredi 10 au Dimanche 14 Décembre 2025",
  reu(1, "Vendredi 12 Décembre 2025", "08h30", [li("09h56", 51, 60, 0, 0, "50 Nage Libre Messieurs Séries", "10 séries / 77 participants <br/>")]) +
  reu(2, "Vendredi 12 Décembre 2025", "16h00", [li(f"17h{20+2*i:02d}", 51, 11, c, i+1, f"50 Nage Libre Messieurs Finale A {a} ans") for i,(a,c) in enumerate([(14,652079),(15,652082),(16,652083),(17,652084),(18,652085)])]))
for n, h in [("prog-canet.html", canet), ("prog-epinal.html", epinal), ("prog-angers.html", angers)]:
    open(os.path.join(D, n), "w", encoding="utf-8").write(h)

# Résultats : une page par épreuve avec tous les tours
def row(pl, nom, an, club, t, q="", sp=None):
    spl = ""
    if sp:
        spl = '<b id="splitAutre"><table class="split">' + "".join(f'<tr> <td class="distance">{d} m : </td> <td class="split">{c}</td> <td class="lap">({l})</td> <td class="relay"></td></tr>' for d,c,l in sp) + '</table></b>'
    return (f'<tr><td colspan="10"></td></tr> <tr class="survol"> <td class="place">{pl}.</td> <td><a href="x?iuf=1{pl}{an}" class="underline">{nom}</a></td> <td>{an}</td> <td>FRA</td> '
            f'<td> <a href="x?structure=9" class="underline">{club}</a> </td> <td class="temps"><a href="#" class="tooltip">{t}{spl}</a></td> <td class="reaction">+0.70</td> '
            f'<td class="tempsRelayeur"></td> <td class="points">1100 pts</td> <td class="qualification">{q}</td> <td class="rem"></td> </tr>')
def sec(title, when, rows):
    return f'<tr> <td colspan="11" class="epreuve"> {title} <span class="gris_clair"> ({when})</span> </td> </tr> ' + " ".join(rows)
def res(body):
    return f'<html><body><table class="tableau"> {body} </table><div id="boxLegende"></div></body></html>'
sp = [(50,"29.10","29.10"),(100,"1:00.13","31.03"),(150,"1:31.53","31.40"),(200,"2:02.61","31.08")]
canet3 = res(
  sec("200 Nage Libre Dames - Finale A", "Vendredi 17 Juillet 2026 - 17h41", [row(1,"VIGUIER Alix",2007,"CANET 66 NATATION","02:02.61",sp=sp), row(2,"RAULT Anais",2009,"CNO ST-GERMAIN-EN-LAYE","02:03.95")]) +
  sec("200 Nage Libre Dames - Finale B &nbsp; U16 : 10-16 ans", "Vendredi 17 Juillet 2026 - 17h37", [row(1,"MARTIN Lalie",2010,"CN CÉVENNES ALÈS","02:05.51"), row(2,"SCHMITT Loane",2011,"DAUPHINS DE ST-LOUIS","02:06.01")]) +
  sec("200 Nage Libre Dames - Finale C &nbsp; U17 : 17 ans", "Vendredi 17 Juillet 2026 - 17h33", [row(1,"AZIZI Lilia",2009,"CNO ST-GERMAIN-EN-LAYE","02:08.14")]) +
  sec("200 Nage Libre Dames - Finale D &nbsp; U15 : 10-15 ans", "Vendredi 17 Juillet 2026 - 17h30", [row(1,"DEFAIX Elina",2012,"CSN GUYANCOURT","02:06.46")]) +
  sec("200 Nage Libre Dames - Séries", "Vendredi 17 Juillet 2026 - 11h09", [row(1,"VIGUIER Alix",2007,"CANET 66 NATATION","02:04.12","QFA"), row(2,"RAULT Anais",2009,"CNO ST-GERMAIN-EN-LAYE","02:04.50","QFA"),
     row(3,"SCHMITT Loane",2011,"DAUPHINS DE ST-LOUIS","02:06.90","QFB"), row(4,"MARTIN Lalie",2010,"CN CÉVENNES ALÈS","02:07.00","QFB"),
     row(5,"AZIZI Lilia",2009,"CNO ST-GERMAIN-EN-LAYE","02:08.03","QFC"), row(6,"DEFAIX Elina",2012,"CSN GUYANCOURT","02:08.50","QFD"), row(7,"DUPONT Zoe",2008,"SR COLMAR","02:15.00")]))
# Canet : séries nagées, finales pas encore (pages publiées entre les deux réunions)
canet3am = res(sec("200 Nage Libre Dames - Séries", "Vendredi 17 Juillet 2026 - 11h09", [row(1,"VIGUIER Alix",2007,"CANET 66 NATATION","02:04.12","QFA"), row(2,"RAULT Anais",2009,"CNO ST-GERMAIN-EN-LAYE","02:04.50","QFA"),
     row(3,"SCHMITT Loane",2011,"DAUPHINS DE ST-LOUIS","02:06.90","QFB"), row(4,"MARTIN Lalie",2010,"CN CÉVENNES ALÈS","02:07.00","QFB"),
     row(5,"AZIZI Lilia",2009,"CNO ST-GERMAIN-EN-LAYE","02:08.03","QFC"), row(6,"DEFAIX Elina",2012,"CSN GUYANCOURT","02:08.50","QFD"), row(7,"DUPONT Zoe",2008,"SR COLMAR","02:15.00")]))
angers51 = res(
  sec("50 Nage Libre Messieurs - Finale A 18 ans : 18 ans", "Vendredi 12 Décembre 2025 - 17h30", [row(1,"DUTRIAUX Néo",2007,"CLUB A","00:23.10")]) +
  sec("50 Nage Libre Messieurs - Finale A 15 ans : 15 ans", "Vendredi 12 Décembre 2025 - 17h22", [row(1,"BERNHARDT Félix",2010,"CLUB B","00:24.10")]) +
  sec("50 Nage Libre Messieurs - Barrage", "Vendredi 12 Décembre 2025 - 10h08", [row(1,"EVEN Yael",2008,"CLUB C","00:24.50","Br"), row(2,"GAMEIRO DOS SANTOS Tiago",2008,"CLUB D","00:24.60","Br")]) +
  sec("50 Nage Libre Messieurs - Séries", "Vendredi 12 Décembre 2025 - 09h56", [row(1,"DUTRIAUX Néo",2007,"CLUB A","00:23.00","QFA"), row(2,"BERNHARDT Félix",2010,"CLUB B","00:24.00","QFA"), row(3,"EVEN Yael",2008,"CLUB C","00:24.40","Br"), row(4,"GAMEIRO DOS SANTOS Tiago",2008,"CLUB D","00:24.40","Br")]))
finB = ('<div class="ProgrammeDetail"> <table class="tableau" style="margin: 5px;"> <tbody id="epr_8" class="hide"> <tr> <td colspan="5" class="prgTitre"> 200 Nage Libre Dames - Finale B - U16 : 10-16 ans </td> <td class="prgTime">17h37</td> </tr> <tr> <td colspan="6"></td> </tr> '
  + " ".join(f'<tr class="survol "> <td><img src="https://www.liveffn.com/media/img/ico_plot_{l}.png"/></td> <td>{n}</td> <td>{y}</td> <td>FRA</td> <td> <span class="tooltip">{c}<b><nobr>{c}</nobr></b></span> </td> <td class="temps">{t}</td> </tr>'
             for l,n,y,c,t in [(4,"SCHMITT Loane",2011,"DAUPHINS DE ST-LOUIS","02:06.90"),(5,"MARTIN Lalie",2010,"CN CÉVENNES ALÈS","02:07.00")]) + ' </tbody></table></div>')
for n, h in [("res-canet-3.html", canet3), ("res-canet-3-matin.html", canet3am), ("res-angers-51.html", angers51), ("heats-canet-finB.html", finB)]:
    open(os.path.join(D, n), "w", encoding="utf-8").write(h)
print("ok")
