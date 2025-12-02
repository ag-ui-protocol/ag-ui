/*
 * Copyright 2016 flipkart.com zjsonpatch.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

package com.agui.client.jsonpatch

import kotlinx.serialization.json.*
import kotlin.jvm.JvmOverloads
import kotlin.jvm.JvmStatic

object JsonPatch {
    internal var op = Operations()
    internal var consts = Constants()

    private fun getPatchAttr(jsonNode: JsonObject, attr: String): JsonElement {
        val child = jsonNode.get(attr) ?: throw InvalidJsonPatchException("Invalid JSON Patch payload (missing '$attr' field)")
        return child
    }

    private fun getPatchAttrWithDefault(jsonNode: JsonObject, attr: String, defaultValue: JsonElement): JsonElement {
        val child = jsonNode.get(attr)
        if (child == null)
            return defaultValue
        else
            return child
    }

    @Throws(InvalidJsonPatchException::class)
    private fun process(patch: JsonElement, processor: JsonPatchApplyProcessor, flags: Set<CompatibilityFlags>) {

        if (patch !is JsonArray)
            throw InvalidJsonPatchException("Invalid JSON Patch payload (not an array)")
        val operations = patch.jsonArray.iterator()
        while (operations.hasNext()) {
            val jsonNode_ = operations.next()
            if (jsonNode_ !is JsonObject) throw InvalidJsonPatchException("Invalid JSON Patch payload (not an object)")
            val jsonNode = jsonNode_.jsonObject
            val operation = op.opFromName(getPatchAttr(jsonNode.jsonObject, consts.OP).toString().replace("\"".toRegex(), ""))
            val path = getPath(getPatchAttr(jsonNode, consts.PATH))

            when (operation) {
                op.REMOVE -> {
                    processor.edit { remove(path) }
                }

                op.ADD -> {
                    val value: JsonElement
                    if (!flags.contains(CompatibilityFlags.MISSING_VALUES_AS_NULLS))
                        value = getPatchAttr(jsonNode, consts.VALUE)
                    else
                        value = getPatchAttrWithDefault(jsonNode, consts.VALUE, JsonNull)
                    processor.edit { add(path, value) }
                }

                op.REPLACE -> {
                    val value: JsonElement
                    if (!flags.contains(CompatibilityFlags.MISSING_VALUES_AS_NULLS))
                        value = getPatchAttr(jsonNode, consts.VALUE)
                    else
                        value = getPatchAttrWithDefault(jsonNode, consts.VALUE, JsonNull)
                    processor.edit { replace(path, value) }
                }

                op.MOVE -> {
                    val fromPath = getPath(getPatchAttr(jsonNode, consts.FROM))
                    processor.edit { move(fromPath, path) }
                }

                op.COPY -> {
                    val fromPath = getPath(getPatchAttr(jsonNode, consts.FROM))
                    processor.edit { copy(fromPath, path) }
                }

                op.TEST -> {
                    val value: JsonElement
                    if (!flags.contains(CompatibilityFlags.MISSING_VALUES_AS_NULLS))
                        value = getPatchAttr(jsonNode, consts.VALUE)
                    else
                        value = getPatchAttrWithDefault(jsonNode, consts.VALUE, JsonNull)
                    processor.edit { test(path, value) }
                }
            }
        }
    }

    @Throws(InvalidJsonPatchException::class)
    @JvmStatic
    @JvmOverloads
    fun validate(patch: JsonElement, flags: Set<CompatibilityFlags> = CompatibilityFlags.defaults()) {
        process(patch, NoopProcessor.INSTANCE, flags)
    }

    @Throws(JsonPatchApplicationException::class)
    @JvmStatic
    @JvmOverloads
    fun apply(patch: JsonElement, source: JsonElement, flags: Set<CompatibilityFlags> = CompatibilityFlags.defaults()): JsonElement {
        val processor = ApplyProcessor(source)
        process(patch, processor, flags)
        return processor.result()
    }


    private fun decodePath(path: String): String {
        return path.replace("~1".toRegex(), "/").replace("~0".toRegex(), "~") // see http://tools.ietf.org/html/rfc6901#section-4
    }

    private fun getPath(path: JsonElement): List<String> {
        //        List<String> paths = Splitter.on('/').splitToList(path.toString().replaceAll("\"", ""));
        //        return Lists.newArrayList(Iterables.transform(paths, DECODE_PATH_FUNCTION));
        val pathstr = path.toString().replace("\"", "")
        val paths = pathstr.split("/")
        return paths.map { decodePath(it) }
    }
}
