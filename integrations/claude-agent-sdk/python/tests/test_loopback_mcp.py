import httpx
import pytest
from claude_agent_sdk import create_sdk_mcp_server
from ag_ui_claude_sdk.loopback_mcp import LoopbackMcpServer

@pytest.mark.asyncio
async def test_authentication_and_cleanup():
    endpoint = LoopbackMcpServer(create_sdk_mcp_server("test", tools=[]))
    config = await endpoint.start()
    try:
        async with httpx.AsyncClient() as client:
            for headers in ({}, {"Authorization": "wrong"}, {**config["headers"], "Host": "attacker.invalid"}):
                assert (await client.get(config["url"], headers=headers)).status_code == 403
            assert (await client.get(config["url"] + "/wrong", headers=config["headers"])).status_code == 403
            assert (await client.get(config["url"], headers=config["headers"])).status_code != 403
    finally:
        await endpoint.close()
        await endpoint.close()
    async with httpx.AsyncClient() as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(config["url"])
