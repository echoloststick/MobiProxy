import os
import requests
from flask import Flask, request

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB -- projetos grandes geram JSON grande

# ---------------------------------------------------------------------------
# Montagem do XML (RBXLX). Antes isso vivia no Lua (PublishSystem), mas o
# editor de script do Roblox no mobile as vezes autoformata aspas/caracteres
# quando o código é colado/editado -- o que corrompia silenciosamente o XML
# gerado. Agora o Lua só manda os dados já resolvidos (className/kind/value)
# como JSON, e quem escreve as tags XML de verdade é aqui.
# ---------------------------------------------------------------------------

XML_ESCAPE = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}


def esc(s):
    s = str(s)
    for k, v in XML_ESCAPE.items():
        s = s.replace(k, v)
    return s


def property_xml(prop_name, kind, value):
    n = esc(prop_name)

    if kind == 'bool':
        return f"<bool name='{n}'>{'true' if value else 'false'}</bool>"
    if kind == 'string':
        return f"<string name='{n}'>{esc(value)}</string>"
    if kind == 'int':
        return f"<int name='{n}'>{int(value)}</int>"
    if kind == 'int64':
        return f"<int64 name='{n}'>{int(value)}</int64>"
    if kind == 'float':
        return f"<float name='{n}'>{value}</float>"
    if kind == 'double':
        return f"<double name='{n}'>{value}</double>"
    if kind == 'token':
        return f"<token name='{n}'>{int(value)}</token>"

    if kind == 'Vector3':
        return f"<Vector3 name='{n}'><X>{value['x']}</X><Y>{value['y']}</Y><Z>{value['z']}</Z></Vector3>"
    if kind == 'Vector2':
        return f"<Vector2 name='{n}'><X>{value['x']}</X><Y>{value['y']}</Y></Vector2>"
    if kind == 'CFrame':
        c = value['c']
        return (
            f"<CoordinateFrame name='{n}'><X>{c[0]}</X><Y>{c[1]}</Y><Z>{c[2]}</Z>"
            f"<R00>{c[3]}</R00><R01>{c[4]}</R01><R02>{c[5]}</R02>"
            f"<R10>{c[6]}</R10><R11>{c[7]}</R11><R12>{c[8]}</R12>"
            f"<R20>{c[9]}</R20><R21>{c[10]}</R21><R22>{c[11]}</R22></CoordinateFrame>"
        )
    if kind == 'Color3':
        return f"<Color3 name='{n}'><R>{value['r']}</R><G>{value['g']}</G><B>{value['b']}</B></Color3>"
    if kind == 'UDim':
        return f"<UDim name='{n}'><S>{value['scale']}</S><O>{int(value['offset'])}</O></UDim>"
    if kind == 'UDim2':
        return (
            f"<UDim2 name='{n}'><XS>{value['x']['scale']}</XS><XO>{int(value['x']['offset'])}</XO>"
            f"<YS>{value['y']['scale']}</YS><YO>{int(value['y']['offset'])}</YO></UDim2>"
        )
    if kind == 'NumberRange':
        return f"<NumberRange name='{n}'>{value['min']} {value['max']}</NumberRange>"
    if kind == 'NumberSequence':
        parts = ' '.join(f"{kp['t']} {kp['v']} {kp['e']}" for kp in value['keypoints'])
        return f"<NumberSequence name='{n}'>{parts}</NumberSequence>"
    if kind == 'ColorSequence':
        parts = ' '.join(f"{kp['t']} {kp['r']} {kp['g']} {kp['b']} 0" for kp in value['keypoints'])
        return f"<ColorSequence name='{n}'>{parts}</ColorSequence>"
    if kind == 'BrickColor':
        return f"<int name='{n}'>{int(value['number'])}</int>"
    if kind == 'PhysicalProperties':
        return (
            f"<PhysicalProperties name='{n}'><CustomPhysics>true</CustomPhysics>"
            f"<Density>{value['density']}</Density><Friction>{value['friction']}</Friction>"
            f"<Elasticity>{value['elasticity']}</Elasticity>"
            f"<FrictionWeight>{value['frictionWeight']}</FrictionWeight>"
            f"<ElasticityWeight>{value['elasticityWeight']}</ElasticityWeight></PhysicalProperties>"
        )
    if kind == 'Content':
        return f"<Content name='{n}'><url>{esc(value)}</url></Content>"

    return None  # kind desconhecido -- ignora em vez de quebrar o publish inteiro


def build_tree(objects):
    nodes = {}
    for id_str, data in objects.items():
        nodes[id_str] = {
            'className': data['className'],
            'properties': data.get('properties') or {},
            'source': data.get('source'),
            'children': [],
        }

    roots = []
    for node in nodes.values():
        parent_prop = node['properties'].get('Parent')
        parent_node = None
        if isinstance(parent_prop, dict) and parent_prop.get('kind') == 'ref':
            ref = (parent_prop.get('value') or {}).get('ref')
            if ref is not None:
                parent_node = nodes.get(str(ref))
        if parent_node:
            parent_node['children'].append(node)
        else:
            roots.append(node)  # sem pai reconhecido (services raiz) vira raiz do arquivo

    return roots, nodes


def assign_referents(node, counter):
    counter[0] += 1
    node['referent'] = f"RBX{counter[0]}"
    for child in node['children']:
        assign_referents(child, counter)


def emit_node(node, out, nodes):
    out.append(f"<Item class='{esc(node['className'])}' referent='{node['referent']}'>")
    out.append('<Properties>')

    for prop_name, prop in node['properties'].items():
        if not isinstance(prop, dict):
            continue
        kind = prop.get('kind')
        value = prop.get('value')

        if kind == 'ref':
            if prop_name != 'Parent':  # Parent já virou aninhamento, não precisa de <Ref>
                ref = value.get('ref') if isinstance(value, dict) else None
                target_node = nodes.get(str(ref)) if ref is not None else None
                target_referent = target_node['referent'] if target_node else 'null'
                out.append(f"<Ref name='{esc(prop_name)}'>{target_referent}</Ref>")
        else:
            try:
                xml = property_xml(prop_name, kind, value)
                if xml:
                    out.append(xml)
            except Exception:
                pass  # uma property ruim não pode derrubar o publish inteiro

    if node.get('source'):
        out.append(f"<ProtectedString name='Source'>{esc(node['source'])}</ProtectedString>")

    out.append('</Properties>')

    for child in node['children']:
        emit_node(child, out, nodes)

    out.append('</Item>')


def build_rbxlx(objects):
    roots, nodes = build_tree(objects)

    counter = [0]
    for root in roots:
        assign_referents(root, counter)

    out = ["<roblox version='4'>"]
    for root in roots:
        emit_node(root, out, nodes)
    out.append('</roblox>')

    return ''.join(out)


# ---------------------------------------------------------------------------
# Rotas
# ---------------------------------------------------------------------------

@app.route('/publish', methods=['POST'])
def publish():
    payload = request.get_json(force=True, silent=True)
    if not payload or 'objects' not in payload or 'url' not in payload:
        return {'error': 'missing objects or url in JSON body'}, 400

    try:
        xml = build_rbxlx(payload['objects'])
    except Exception as e:
        return {'error': f'failed to build xml: {e}'}, 500

    api_key = request.headers.get('x-api-key')
    if not api_key:
        return {'error': 'missing x-api-key header'}, 400

    try:
        resposta = requests.post(
            payload['url'],
            headers={
                'x-api-key': api_key,
                'Content-Type': 'application/xml',
            },
            data=xml.encode('utf-8'),
            timeout=60,
        )
    except requests.RequestException as e:
        return {'error': f'upstream request failed: {e}'}, 502

    return resposta.content, resposta.status_code


# Proxy GET genérico -- usado pra endpoints de leitura da api.roblox.com que o HttpService
# do jogo não alcança direto (ex.: resolver universeId a partir do placeId). x-api-key é
# opcional aqui porque a maioria desses endpoints de leitura são públicos.
@app.route('/get', methods=['GET'])
def get_proxy():
    url = request.args.get('url')
    if not url:
        return {'error': 'missing url query param'}, 400

    headers = {}
    api_key = request.headers.get('x-api-key')
    if api_key:
        headers['x-api-key'] = api_key

    try:
        resposta = requests.get(url, headers=headers, timeout=30)
    except requests.RequestException as e:
        return {'error': f'upstream request failed: {e}'}, 502

    content_type = resposta.headers.get('Content-Type', 'application/json')
    return resposta.content, resposta.status_code, {'Content-Type': content_type}


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, threaded=True)
